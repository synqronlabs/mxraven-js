/**
 * Envelope command construction and send-path helpers.
 *
 * @internal
 */

import { SMTPError } from "../../errors.js";
import { mailboxToString, type MailboxAddress } from "../address.js";
import {
  formatDsnEnvelopeId,
  formatDsnOriginalRecipient,
  normalizeDsnNotify,
  normalizeDsnReturn,
} from "./dsn.js";
import { SmtpSessionError, smtpSessionErrorKind } from "./errors.js";
import { smtpExtension } from "./extensions.js";
import { isSuccess, type SmtpResponse } from "./response.js";

/** The RFC 6152 body type advertised by `MAIL FROM`. */
export type SmtpBodyType = "7BIT" | "8BITMIME" | "BINARYMIME";

/** The RFC 2852 DELIVERBY mode. */
export type DeliveryByMode = "N" | "R";

/** An RFC 2852 delivery deadline. */
export interface SmtpDeliveryBy {
  /** The interval in seconds. */
  readonly seconds: number;
  /** `N` to notify, `R` to return. */
  readonly mode: DeliveryByMode;
  /** Whether `T` tracing is requested. */
  readonly trace?: boolean;
}

/** One envelope recipient. */
export interface SmtpRecipient {
  /** The recipient mailbox. */
  readonly address: MailboxAddress;
  /** RFC 3461 `NOTIFY` values. */
  readonly dsnNotify?: readonly string[];
  /** RFC 3461 `ORCPT` value in `address-type;address` form. */
  readonly dsnOrcpt?: string;
}

/** An SMTP envelope for a transaction. */
export interface SmtpEnvelope {
  /** The reverse-path, or `undefined` for a null sender. */
  readonly from: MailboxAddress | undefined;
  /** At least one recipient. */
  readonly recipients: readonly SmtpRecipient[];
  /** The declared `SIZE`, when the extension is used. */
  readonly size?: number;
  /** Requests the `SMTPUTF8` parameter. */
  readonly smtpUtf8?: boolean;
  /** The `BODY` parameter. */
  readonly bodyType?: SmtpBodyType;
  /** Requests `REQUIRETLS` (RFC 8689). */
  readonly requireTls?: boolean;
  /** Requests `DELIVERBY` (RFC 2852). */
  readonly deliveryBy?: SmtpDeliveryBy;
  /** The `ENVID` value, before xtext encoding. */
  readonly envid?: string;
  /** The `AUTH` parameter value. */
  readonly auth?: string;
  /** The envelope-level `RET` DSN value. */
  readonly dsnRet?: string;
  /** Additional `MAIL FROM` parameters. */
  readonly extensionParams?: ReadonlyMap<string, string>;
}

/** The server facts needed to build envelope commands. */
export interface CommandContext {
  /** Whether the session is using TLS. */
  readonly isTls: boolean;
  /** Reports whether an extension was advertised. */
  hasExtension(name: string): boolean;
  /** Returns an extension parameter, or an empty string. */
  getExtensionParam(name: string): string;
}

/** Per-recipient transaction outcome. */
export interface RecipientOutcome {
  /** The recipient address as submitted. */
  readonly address: string;
  /** Whether the server accepted the recipient. */
  readonly accepted: boolean;
  /** The server's reply for this recipient. */
  readonly response?: SmtpResponse;
  /** The rejection reason when not accepted. */
  readonly error?: Error;
}

/** The result of a mail transaction. */
export interface TransactionResult {
  /** Whether the transaction completed successfully. */
  success: boolean;
  /** The server-assigned message identifier, when one was parsed. */
  messageId: string;
  /** The final DATA reply, when DATA was used. */
  response?: SmtpResponse;
  /** Per-recipient outcomes. */
  recipients: RecipientOutcome[];
}

/** Options controlling a transaction. */
export interface SendOptions {
  /** Forces chunked BDAT when the server supports `CHUNKING`. */
  readonly preferBdat?: boolean;
  /** The BDAT chunk size in bytes. Defaults to 64 KiB. */
  readonly chunkSize?: number;
  /** Fails the transaction when any recipient is rejected. */
  readonly requireAllRecipients?: boolean;
}

/** The default BDAT chunk size. */
export const DEFAULT_BDAT_CHUNK_SIZE = 64 * 1024;

/** The size above which `Send` uses a single BDAT transfer when available. */
export const AUTO_BDAT_THRESHOLD = 1024 * 1024;

/**
 * Builds the `MAIL FROM` command for an envelope.
 *
 * @param context - The server capabilities.
 * @param envelope - The envelope.
 * @returns The command without a terminating CRLF.
 * @throws {@link SMTPError} When `REQUIRETLS` is requested but unavailable.
 * @throws {@link SmtpSessionError} When `DELIVERBY` is requested but unsupported.
 */
export function buildMailFromCommand(context: CommandContext, envelope: SmtpEnvelope): string {
  const params: string[] = [];

  if (
    context.hasExtension(smtpExtension.size) &&
    envelope.size !== undefined &&
    envelope.size > 0
  ) {
    params.push(`SIZE=${envelope.size}`);
  }
  if (envelope.bodyType === "8BITMIME" && context.hasExtension(smtpExtension.eightBitMime)) {
    params.push("BODY=8BITMIME");
  }
  if (envelope.bodyType === "BINARYMIME" && context.hasExtension(smtpExtension.binaryMime)) {
    params.push("BODY=BINARYMIME");
  }
  if (envelope.smtpUtf8 === true && context.hasExtension(smtpExtension.smtpUtf8)) {
    params.push("SMTPUTF8");
  }
  if (envelope.requireTls === true) {
    if (!context.isTls) {
      throw new SMTPError({
        code: 550,
        enhancedCode: "5.7.30",
        message: "REQUIRETLS requires an active TLS session",
      });
    }
    if (!context.hasExtension(smtpExtension.requireTls)) {
      throw new SMTPError({
        code: 550,
        enhancedCode: "5.7.30",
        message: "REQUIRETLS support required",
      });
    }
    params.push("REQUIRETLS");
  }

  if (envelope.deliveryBy !== undefined) {
    if (!context.hasExtension(smtpExtension.deliverBy)) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.deliveryByNotSupported,
        "smtp: server does not support DELIVERBY",
      );
    }
    const value = formatDeliveryBy(envelope.deliveryBy);
    if (envelope.deliveryBy.mode === "R") {
      const minimum = parseDeliveryByMinimum(context.getExtensionParam(smtpExtension.deliverBy));
      if (minimum > 0 && envelope.deliveryBy.seconds < minimum) {
        throw new Error(
          `smtp: DELIVERYBY BY time ${envelope.deliveryBy.seconds} is below server minimum ${minimum}`,
        );
      }
    }
    params.push(`BY=${value}`);
  }

  if (envelope.auth !== undefined && envelope.auth !== "") {
    params.push(`AUTH=<${envelope.auth}>`);
  }
  if (
    envelope.dsnRet !== undefined &&
    envelope.dsnRet !== "" &&
    context.hasExtension(smtpExtension.dsn)
  ) {
    params.push(`RET=${normalizeDsnReturn(envelope.dsnRet)}`);
  }
  if (
    envelope.envid !== undefined &&
    envelope.envid !== "" &&
    context.hasExtension(smtpExtension.dsn)
  ) {
    params.push(`ENVID=${formatDsnEnvelopeId(envelope.envid)}`);
  }

  for (const [name, value] of envelope.extensionParams ?? []) {
    if (name.toUpperCase() === "BY" && envelope.deliveryBy !== undefined) {
      continue;
    }
    params.push(value === "" ? name.toUpperCase() : `${name.toUpperCase()}=${value}`);
  }

  const reversePath = envelope.from === undefined ? "<>" : `<${mailboxToString(envelope.from)}>`;
  const command = `MAIL FROM:${reversePath}`;
  return params.length > 0 ? `${command} ${params.join(" ")}` : command;
}

/**
 * Builds the `RCPT TO` command for one recipient.
 *
 * @param context - The server capabilities.
 * @param recipient - The recipient.
 * @param smtpUtf8 - Whether the envelope negotiated SMTPUTF8.
 * @returns The command without a terminating CRLF.
 * @throws `Error` When a DSN parameter is malformed.
 */
export function buildRcptToCommand(
  context: CommandContext,
  recipient: SmtpRecipient,
  smtpUtf8: boolean,
): string {
  const params: string[] = [];

  if (context.hasExtension(smtpExtension.dsn)) {
    if (recipient.dsnNotify !== undefined && recipient.dsnNotify.length > 0) {
      params.push(`NOTIFY=${normalizeDsnNotify(recipient.dsnNotify).join(",")}`);
    }
    if (recipient.dsnOrcpt !== undefined && recipient.dsnOrcpt !== "") {
      const separator = recipient.dsnOrcpt.indexOf(";");
      if (separator < 0) {
        throw new Error("smtp: invalid DSN ORCPT: expected address-type;address");
      }
      const addressType = recipient.dsnOrcpt.slice(0, separator);
      const address = recipient.dsnOrcpt.slice(separator + 1);
      params.push(`ORCPT=${formatDsnOriginalRecipient(addressType, address, smtpUtf8)}`);
    }
  }

  const command = `RCPT TO:<${mailboxToString(recipient.address)}>`;
  return params.length > 0 ? `${command} ${params.join(" ")}` : command;
}

/** Builds the per-recipient outcome from a reply. */
export function recipientOutcome(
  recipient: SmtpRecipient,
  response: SmtpResponse,
): RecipientOutcome {
  const address = mailboxToString(recipient.address);
  if (isSuccess(response.code)) {
    return { address, accepted: true, response };
  }
  return {
    address,
    accepted: false,
    response,
    error: new SMTPError({
      code: response.code,
      enhancedCode: response.enhancedCode === "" ? undefined : response.enhancedCode,
      message: response.message,
    }),
  };
}

/** Formats a DELIVERBY value. */
function formatDeliveryBy(deliveryBy: SmtpDeliveryBy): string {
  const mode = deliveryBy.mode.toUpperCase();
  if (mode !== "N" && mode !== "R") {
    throw new Error(`smtp: invalid DELIVERYBY mode ${JSON.stringify(deliveryBy.mode)}`);
  }
  if (mode === "R" && deliveryBy.seconds <= 0) {
    throw new Error("smtp: DELIVERYBY mode R requires seconds > 0");
  }
  return `${deliveryBy.seconds};${mode}${deliveryBy.trace === true ? "T" : ""}`;
}

/** Parses a DELIVERBY minimum interval, returning 0 when absent or invalid. */
function parseDeliveryByMinimum(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return 0;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/**
 * Applies SMTP dot-stuffing to a complete buffer.
 *
 * @param data - The message bytes.
 * @returns The stuffed bytes, or the input when no stuffing was needed.
 */
export function dotStuff(data: Uint8Array): Uint8Array {
  let count = 0;
  let atLineStart = true;
  for (const byte of data) {
    if (atLineStart && byte === 0x2e) {
      count += 1;
    }
    atLineStart = byte === 0x0a;
  }
  if (count === 0) {
    return data;
  }

  const result = new Uint8Array(data.length + count);
  let index = 0;
  atLineStart = true;
  for (const byte of data) {
    if (atLineStart && byte === 0x2e) {
      result[index] = 0x2e;
      index += 1;
    }
    result[index] = byte;
    index += 1;
    atLineStart = byte === 0x0a;
  }
  return result;
}

/** The streaming dot-stuffing state carried between chunks. */
export interface DotStuffState {
  /** The stuffed chunk. */
  readonly data: Uint8Array;
  /** Whether the next byte starts a line. */
  readonly atLineStart: boolean;
}

/**
 * Applies dot-stuffing to one chunk, carrying line-start state across chunks.
 *
 * @param chunk - The chunk to stuff.
 * @param atLineStart - Whether the chunk starts a line.
 * @returns The stuffed chunk and the next line-start state.
 */
export function dotStuffChunk(chunk: Uint8Array, atLineStart: boolean): DotStuffState {
  let output: number[] | undefined;
  let state = atLineStart;

  for (let index = 0; index < chunk.length; index += 1) {
    const byte = chunk[index] ?? 0;
    if (state && byte === 0x2e) {
      output ??= Array.from(chunk.subarray(0, index));
      output.push(0x2e);
    }
    output?.push(byte);
    state = byte === 0x0a;
  }

  return {
    data: output === undefined ? chunk : Uint8Array.from(output),
    atLineStart: state,
  };
}

/**
 * Extracts a message identifier from a final reply.
 *
 * Recognizes angle-bracketed identifiers, `queued as <id>`, and `id=<id>`.
 *
 * @param message - The reply text.
 * @returns The identifier, or an empty string.
 */
export function extractMessageId(message: string): string {
  const trimmed = message.trim();

  const start = trimmed.indexOf("<");
  if (start !== -1) {
    const end = trimmed.indexOf(">", start);
    if (end !== -1) {
      return trimmed.slice(start, end + 1);
    }
  }

  const lower = trimmed.toLowerCase();
  const queued = lower.indexOf("queued as ");
  if (queued !== -1) {
    const parts = trimmed
      .slice(queued + "queued as ".length)
      .trim()
      .split(/\s+/);
    if ((parts[0] ?? "") !== "") {
      return parts[0] ?? "";
    }
  }

  const id = lower.indexOf("id=");
  if (id !== -1) {
    const parts = trimmed
      .slice(id + "id=".length)
      .trim()
      .split(/\s+/);
    if ((parts[0] ?? "") !== "") {
      return parts[0] ?? "";
    }
  }

  return "";
}
