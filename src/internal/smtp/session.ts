/**
 * The SMTP session: connect, EHLO, STARTTLS, AUTH, and the stateless commands.
 *
 * A session is bound to a single connection and is not safe for concurrent use.
 * Higher layers (the dialer and pool) own session lifecycle.
 *
 * @internal
 */

import { isIP } from "node:net";
import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

import { mailboxToString } from "../address.js";
import { encodeLoginAuth, encodePlainAuth, selectAuthMechanism } from "./auth.js";
import { LineConnection, type OpenConnectionOptions } from "./connection.js";
import { SmtpSessionError, SmtpTransactionError, smtpSessionErrorKind } from "./errors.js";
import {
  capabilitiesFrom,
  parseExtensions,
  smtpExtension,
  type SmtpCapabilities,
} from "./extensions.js";
import {
  isIntermediate,
  isSuccess,
  parseEnhancedCode,
  responseError,
  type SmtpResponse,
} from "./response.js";
import {
  AUTO_BDAT_THRESHOLD,
  DEFAULT_BDAT_CHUNK_SIZE,
  buildMailFromCommand,
  buildRcptToCommand,
  dotStuffChunk,
  extractMessageId,
  recipientOutcome,
  type RecipientOutcome,
  type SendOptions,
  type SmtpEnvelope,
  type SmtpRecipient,
  type TransactionResult,
} from "./transaction.js";

/** Authentication credentials and optional preferred mechanisms. */
export interface SmtpAuthOptions {
  /** The submission key username. */
  readonly username: string;
  /** The submission key secret. */
  readonly password: string;
  /** Preferred SASL mechanisms, tried in order. */
  readonly mechanisms?: readonly string[];
}

/** Options for an {@link SmtpSession}. */
export interface SmtpSessionOptions {
  /** The server host. */
  readonly host: string;
  /** The server port. */
  readonly port: number;
  /** The name sent in EHLO/HELO. Defaults to `localhost`. */
  readonly localName?: string;
  /** A local address to bind the socket to. */
  readonly localAddress?: string;
  /** The TCP connect deadline in milliseconds. Defaults to 30000. */
  readonly connectTimeout?: number;
  /** The per-read deadline in milliseconds. Defaults to 300000. */
  readonly readTimeout?: number;
  /** The per-write deadline in milliseconds. Defaults to 300000. */
  readonly writeTimeout?: number;
  /** TLS options for STARTTLS and implicit TLS. */
  readonly tls?: TlsConnectionOptions;
  /** Credentials used by {@link SmtpSession.auth}. */
  readonly auth?: SmtpAuthOptions;
  /** Receives each command and reply line as it is exchanged. */
  readonly debug?: (direction: "client" | "server", line: string) => void;
}

const DEFAULT_LOCAL_NAME = "localhost";
const DEFAULT_CONNECT_TIMEOUT = 30_000;
const DEFAULT_READ_TIMEOUT = 300_000;
const DEFAULT_WRITE_TIMEOUT = 300_000;

/** An SMTP session over one connection. */
export class SmtpSession {
  private readonly options: Required<
    Pick<
      SmtpSessionOptions,
      "host" | "port" | "localName" | "connectTimeout" | "readTimeout" | "writeTimeout"
    >
  > &
    SmtpSessionOptions;
  private connection: LineConnection | undefined;
  private extensions = new Map<string, string>();
  private esmtp = false;
  private authenticated = false;
  private closed = false;
  private greetingText = "";
  private hostnameText = "";
  private serverNameText = "";
  private lastResponseValue: SmtpResponse | undefined;

  constructor(options: SmtpSessionOptions) {
    this.options = {
      ...options,
      localName: options.localName ?? DEFAULT_LOCAL_NAME,
      connectTimeout: options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
      readTimeout: options.readTimeout ?? DEFAULT_READ_TIMEOUT,
      writeTimeout: options.writeTimeout ?? DEFAULT_WRITE_TIMEOUT,
    };
  }

  /** The server hostname reported in the greeting. */
  get greeting(): string {
    return this.greetingText;
  }

  /** The server host as configured. */
  get serverName(): string {
    return this.serverNameText;
  }

  /** The most recent reply, or `undefined` before the first reply. */
  get lastResponse(): SmtpResponse | undefined {
    return this.lastResponseValue;
  }

  /** Whether the connection is protected by TLS. */
  get isTls(): boolean {
    return this.connection?.isTls ?? false;
  }

  /** Whether EHLO was accepted. */
  get isEsmtp(): boolean {
    return this.esmtp;
  }

  /** Whether authentication succeeded. */
  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Returns a copy of the advertised extensions. */
  extensionsSnapshot(): ReadonlyMap<string, string> {
    return new Map(this.extensions);
  }

  /** Reports whether the server advertised an extension. */
  hasExtension(name: string): boolean {
    return this.extensions.has(name.toUpperCase());
  }

  /** Returns an extension's parameter, or an empty string. */
  getExtensionParam(name: string): string {
    return this.extensions.get(name.toUpperCase()) ?? "";
  }

  /** Returns a read-only view of the server capabilities. */
  capabilities(): SmtpCapabilities {
    return capabilitiesFrom(this.extensions, this.esmtp, this.hostnameText);
  }

  /** Returns the maximum message size advertised via `SIZE`, or 0. */
  maxSize(): number {
    return this.capabilities().maxSize;
  }

  /** Connects over plain TCP and reads the greeting. */
  async connect(signal?: AbortSignal): Promise<void> {
    await this.open(false, signal);
  }

  /** Connects using implicit TLS and reads the greeting. */
  async connectTls(signal?: AbortSignal): Promise<void> {
    await this.open(true, signal);
  }

  /** Sends EHLO, falling back to HELO when EHLO is rejected. */
  async hello(signal?: AbortSignal): Promise<void> {
    this.requireConnection();
    this.ensureNotClosed();

    const response = await this.command(`EHLO ${this.options.localName}`, signal);
    if (isSuccess(response.code)) {
      this.esmtp = true;
      this.extensions = parseExtensions(response.lines);
      this.hostnameText = (response.lines[0] ?? "").split(" ")[0] ?? "";
      return;
    }

    const fallback = await this.command(`HELO ${this.options.localName}`, signal);
    if (!isSuccess(fallback.code)) {
      throw this.requireReplyError(fallback);
    }
    this.esmtp = false;
    this.extensions = new Map();
    this.hostnameText = "";
  }

  /** Upgrades the connection with STARTTLS. */
  async startTls(signal?: AbortSignal): Promise<void> {
    const connection = this.requireConnection();
    if (connection.isTls) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.tlsAlreadyActive,
        "smtp: TLS is already active",
      );
    }
    if (!this.hasExtension(smtpExtension.startTls)) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.tlsNotSupported,
        "smtp: server does not support STARTTLS",
      );
    }

    const response = await this.command("STARTTLS", signal);
    if (!isSuccess(response.code)) {
      throw this.requireReplyError(response);
    }

    await connection.upgradeToTls(this.tlsOptions(), this.options.connectTimeout, signal);
    this.extensions = new Map();
    this.esmtp = false;
    this.hostnameText = "";
  }

  /** Authenticates using a mechanism advertised by the server. */
  async auth(signal?: AbortSignal): Promise<void> {
    this.requireConnection();
    const auth = this.options.auth;
    if (auth === undefined) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.noCredentials,
        "smtp: no authentication credentials configured",
      );
    }
    if (!this.hasExtension(smtpExtension.auth)) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.extensionNotSupported,
        "smtp: server does not support the AUTH extension",
      );
    }

    const mechanisms = this.getExtensionParam(smtpExtension.auth)
      .split(/\s+/)
      .filter((value) => value !== "");
    const mechanism = selectAuthMechanism(auth.mechanisms ?? [], mechanisms);
    if (mechanism === "") {
      throw new SmtpSessionError(
        smtpSessionErrorKind.authFailed,
        "smtp: no supported authentication mechanism available",
      );
    }
    await this.authWithMechanism(mechanism, signal);
  }

  /** Authenticates using an explicit mechanism. */
  async authWithMechanism(mechanism: string, signal?: AbortSignal): Promise<void> {
    this.requireConnection();
    const auth = this.options.auth;
    if (auth === undefined) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.noCredentials,
        "smtp: no authentication credentials configured",
      );
    }

    switch (mechanism.toUpperCase()) {
      case "PLAIN":
        await this.authPlain(auth, signal);
        return;
      case "LOGIN":
        await this.authLogin(auth, signal);
        return;
      default:
        throw new SmtpSessionError(
          smtpSessionErrorKind.unsupportedMechanism,
          `smtp: unsupported authentication mechanism: ${mechanism}`,
        );
    }
  }

  /** Sends RSET. */
  async reset(signal?: AbortSignal): Promise<void> {
    const response = await this.command("RSET", signal);
    if (!isSuccess(response.code)) {
      throw this.requireReplyError(response);
    }
  }

  /** Sends NOOP. */
  async noop(signal?: AbortSignal): Promise<void> {
    const response = await this.command("NOOP", signal);
    if (!isSuccess(response.code)) {
      throw this.requireReplyError(response);
    }
  }

  /** Sends QUIT and closes the connection, ignoring reply failures. */
  async quit(signal?: AbortSignal): Promise<void> {
    const connection = this.requireConnection();
    try {
      await this.writeCommand("QUIT", signal);
      await this.readReply(signal);
    } catch {
      // Some servers close immediately after QUIT; closing the socket still
      // completes cleanup.
    } finally {
      connection.close();
      this.connection = undefined;
      this.authenticated = false;
    }
  }

  /** Closes the connection. It is safe to call more than once. */
  close(): void {
    this.closed = true;
    this.connection?.close();
    this.connection = undefined;
    this.authenticated = false;
  }

  private async open(implicitTls: boolean, signal?: AbortSignal): Promise<void> {
    this.ensureNotClosed();
    if (this.connection !== undefined) {
      this.connection.close();
      this.connection = undefined;
    }

    const options = this.connectionOptions();
    this.connection = implicitTls
      ? await LineConnection.openTls(options, signal)
      : await LineConnection.openTcp(options, signal);
    this.serverNameText = this.options.host;

    const response = await this.readReply(signal);
    if (!isSuccess(response.code)) {
      this.connection.close();
      this.connection = undefined;
      throw this.requireReplyError(response);
    }
    this.greetingText = response.message;
  }

  private async authPlain(auth: SmtpAuthOptions, signal?: AbortSignal): Promise<void> {
    const response = await this.command(
      `AUTH PLAIN ${encodePlainAuth(auth.username, auth.password)}`,
      signal,
    );
    if (!isSuccess(response.code)) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.authFailed,
        `smtp: authentication failed: ${response.message}`,
      );
    }
    this.authenticated = true;
  }

  private async authLogin(auth: SmtpAuthOptions, signal?: AbortSignal): Promise<void> {
    const challenge = await this.command("AUTH LOGIN", signal);
    if (challenge.code !== 334) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.authFailed,
        `smtp: authentication failed: unexpected response ${challenge.code}`,
      );
    }

    const passwordChallenge = await this.command(encodeLoginAuth(auth.username), signal);
    if (passwordChallenge.code !== 334) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.authFailed,
        `smtp: authentication failed: unexpected response ${passwordChallenge.code}`,
      );
    }

    const response = await this.command(encodeLoginAuth(auth.password), signal);
    if (!isSuccess(response.code)) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.authFailed,
        `smtp: authentication failed: ${response.message}`,
      );
    }
    this.authenticated = true;
  }

  private async command(command: string, signal?: AbortSignal): Promise<SmtpResponse> {
    await this.writeCommand(command, signal);
    return this.readReply(signal);
  }

  async writeCommand(command: string, signal?: AbortSignal): Promise<void> {
    const connection = this.requireConnection();
    this.options.debug?.("client", command);
    const verb = command.split(" ", 1)[0] ?? command;
    await connection.write(`${command}\r\n`, {
      signal,
      timeout: this.options.writeTimeout,
      operation: `write ${verb}`,
    });
  }

  async readReply(signal?: AbortSignal): Promise<SmtpResponse> {
    const connection = this.requireConnection();
    const lines: string[] = [];
    let code = 0;

    for (;;) {
      const raw = await connection.readLine({
        signal,
        timeout: this.options.readTimeout,
        operation: "read reply",
      });
      const line = raw.replace(/\r?\n$/, "");
      this.options.debug?.("server", line);

      if (line.length < 4) {
        throw new SmtpSessionError(
          smtpSessionErrorKind.unexpectedResponse,
          `smtp: malformed reply line ${JSON.stringify(line)}`,
        );
      }
      if (!/^\d{3}$/.test(line.slice(0, 3))) {
        throw new SmtpSessionError(
          smtpSessionErrorKind.unexpectedResponse,
          `smtp: invalid reply code in ${JSON.stringify(line)}`,
        );
      }
      const lineCode = Number.parseInt(line.slice(0, 3), 10);
      if (code === 0) {
        code = lineCode;
      } else if (lineCode !== code) {
        throw new SmtpSessionError(
          smtpSessionErrorKind.unexpectedResponse,
          "smtp: reply used inconsistent status codes",
        );
      }

      lines.push(line.length > 4 ? line.slice(4) : "");
      if (line[3] === " ") {
        break;
      }
    }

    const response: SmtpResponse = {
      code,
      message: lines.join("\n"),
      lines,
      enhancedCode: parseEnhancedCode(lines[0] ?? ""),
    };
    this.lastResponseValue = response;
    return response;
  }

  /**
   * Runs a mail transaction for an already-serialized message.
   *
   * When the message is a single buffer larger than 1 MiB and the server
   * advertises `CHUNKING`, a single BDAT transfer is used; otherwise the
   * payload is streamed with DATA and dot-stuffing.
   */
  async send(
    envelope: SmtpEnvelope,
    data: Uint8Array | AsyncIterable<Uint8Array>,
    options: SendOptions = {},
    signal?: AbortSignal,
  ): Promise<TransactionResult> {
    return this.runTransaction(envelope, data, options, true, signal);
  }

  /**
   * Runs a mail transaction for a raw message stream.
   *
   * Unlike {@link SmtpSession.send}, a large payload is not automatically sent
   * with BDAT; chunked BDAT is used only when `options.preferBdat` is set.
   */
  async sendRaw(
    envelope: SmtpEnvelope,
    data: Uint8Array | AsyncIterable<Uint8Array>,
    options: SendOptions = {},
    signal?: AbortSignal,
  ): Promise<TransactionResult> {
    return this.runTransaction(envelope, data, options, false, signal);
  }

  /** Sends RSET when a transaction fails, ignoring any further error. */
  async bestEffortReset(signal?: AbortSignal): Promise<void> {
    try {
      await this.writeCommand("RSET", signal);
      await this.readReply(signal);
    } catch {
      // Best effort: the transaction is already failing.
    }
  }

  /** Writes raw bytes with the configured write deadline. */
  async writeBlock(data: string | Uint8Array, signal?: AbortSignal): Promise<void> {
    const connection = this.requireConnection();
    await connection.write(data, {
      signal,
      timeout: this.options.writeTimeout,
      operation: "write data",
    });
  }

  private async runTransaction(
    envelope: SmtpEnvelope,
    data: Uint8Array | AsyncIterable<Uint8Array>,
    options: SendOptions,
    autoBdat: boolean,
    signal?: AbortSignal,
  ): Promise<TransactionResult> {
    this.requireConnection();
    if (envelope.recipients.length === 0) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.noRecipients,
        "smtp: no recipients specified",
      );
    }

    const [result, accepted] = await this.sendEnvelope(envelope, options, signal);
    if (accepted === 0) {
      await this.bestEffortReset(signal);
      throw new SmtpTransactionError("smtp: transaction failed: all recipients rejected", result);
    }

    const chunks = toAsyncChunks(data);
    const knownSize = data instanceof Uint8Array ? data.byteLength : undefined;
    if (options.preferBdat === true && this.hasExtension(smtpExtension.chunking)) {
      await this.sendBdatChunked(chunks, options.chunkSize ?? DEFAULT_BDAT_CHUNK_SIZE, signal);
    } else if (
      autoBdat &&
      this.hasExtension(smtpExtension.chunking) &&
      knownSize !== undefined &&
      knownSize > AUTO_BDAT_THRESHOLD
    ) {
      await this.sendBdatSingle(data as Uint8Array, signal);
    } else {
      const response = await this.sendData(chunks, signal);
      result.response = response;
      result.messageId = extractMessageId(response.message);
    }

    result.success = true;
    return result;
  }

  private async sendEnvelope(
    envelope: SmtpEnvelope,
    options: SendOptions,
    signal?: AbortSignal,
  ): Promise<[TransactionResult, number]> {
    const smtpUtf8 = envelope.smtpUtf8 === true;
    buildMailFromCommand(this, envelope);
    for (const recipient of envelope.recipients) {
      buildRcptToCommand(this, recipient, smtpUtf8);
    }
    if (this.hasExtension(smtpExtension.pipelining)) {
      return this.sendEnvelopePipelined(envelope, options, signal);
    }
    return this.sendEnvelopeSequential(envelope, options, signal);
  }

  private async sendEnvelopeSequential(
    envelope: SmtpEnvelope,
    options: SendOptions,
    signal?: AbortSignal,
  ): Promise<[TransactionResult, number]> {
    const result: TransactionResult = { success: false, messageId: "", recipients: [] };
    const smtpUtf8 = envelope.smtpUtf8 === true;

    await this.writeCommand(buildMailFromCommand(this, envelope), signal);
    const mailResponse = await this.readReply(signal);
    if (!isSuccess(mailResponse.code)) {
      throw this.requireReplyError(mailResponse);
    }

    let accepted = 0;
    for (const recipient of envelope.recipients) {
      const outcome = await this.sendRcptTo(recipient, smtpUtf8, signal);
      result.recipients.push(outcome);
      if (outcome.accepted) {
        accepted += 1;
      } else if (options.requireAllRecipients === true) {
        await this.bestEffortReset(signal);
        throw new SmtpTransactionError(
          `smtp: transaction failed: recipient ${outcome.address} rejected`,
          result,
        );
      }
    }
    return [result, accepted];
  }

  private async sendEnvelopePipelined(
    envelope: SmtpEnvelope,
    options: SendOptions,
    signal?: AbortSignal,
  ): Promise<[TransactionResult, number]> {
    const smtpUtf8 = envelope.smtpUtf8 === true;
    const commands = [
      buildMailFromCommand(this, envelope),
      ...envelope.recipients.map((recipient) => buildRcptToCommand(this, recipient, smtpUtf8)),
    ];
    await this.writePipeline(commands, signal);

    const mailResponse = await this.readReply(signal);
    const result: TransactionResult = { success: false, messageId: "", recipients: [] };
    let accepted = 0;
    let firstRejected = "";

    for (const recipient of envelope.recipients) {
      let response: SmtpResponse;
      try {
        response = await this.readReply(signal);
      } catch (error) {
        result.recipients.push({
          address: mailboxToString(recipient.address),
          accepted: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return [result, accepted];
      }
      const outcome = recipientOutcome(recipient, response);
      result.recipients.push(outcome);
      if (outcome.accepted) {
        accepted += 1;
      } else if (firstRejected === "") {
        firstRejected = outcome.address;
      }
    }

    if (!isSuccess(mailResponse.code)) {
      throw this.requireReplyError(mailResponse);
    }
    if (options.requireAllRecipients === true && firstRejected !== "") {
      await this.bestEffortReset(signal);
      throw new SmtpTransactionError(
        `smtp: transaction failed: recipient ${firstRejected} rejected`,
        result,
      );
    }
    return [result, accepted];
  }

  private async sendRcptTo(
    recipient: SmtpRecipient,
    smtpUtf8: boolean,
    signal?: AbortSignal,
  ): Promise<RecipientOutcome> {
    const address = mailboxToString(recipient.address);
    try {
      await this.writeCommand(buildRcptToCommand(this, recipient, smtpUtf8), signal);
    } catch (error) {
      return {
        address,
        accepted: false,
        error: contextError(error, `write RCPT TO for ${address}`),
      };
    }
    try {
      const response = await this.readReply(signal);
      return recipientOutcome(recipient, response);
    } catch (error) {
      return {
        address,
        accepted: false,
        error: contextError(error, `read RCPT TO for ${address}`),
      };
    }
  }

  private async sendData(
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<SmtpResponse> {
    await this.writeCommand("DATA", signal);
    const intermediate = await this.readReply(signal);
    if (!isIntermediate(intermediate.code)) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.dataFailed,
        `smtp: DATA command failed: expected 354, got ${intermediate.code}`,
      );
    }

    let atLineStart = true;
    let previous = 0;
    let last = 0;
    let wrote = false;

    for await (const chunk of chunks) {
      const stuffed = dotStuffChunk(chunk, atLineStart);
      atLineStart = stuffed.atLineStart;
      if (chunk.length > 0) {
        if (chunk.length >= 2) {
          previous = chunk[chunk.length - 2] ?? 0;
        } else {
          previous = last;
        }
        last = chunk[chunk.length - 1] ?? 0;
        wrote = true;
      }
      await this.writeBlock(stuffed.data, signal);
    }

    if (wrote && (previous !== 0x0d || last !== 0x0a)) {
      await this.writeBlock("\r\n", signal);
    }
    await this.writeBlock(".\r\n", signal);

    const final = await this.readReply(signal);
    if (!isSuccess(final.code)) {
      throw this.requireReplyError(final);
    }
    return final;
  }

  private async sendBdatSingle(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.writeCommand(`BDAT ${data.byteLength} LAST`, signal);
    await this.writeBlock(data, signal);
    const response = await this.readReply(signal);
    if (!isSuccess(response.code)) {
      throw this.requireReplyError(response);
    }
  }

  private async sendBdatChunked(
    chunks: AsyncIterable<Uint8Array>,
    chunkSize: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error("smtp: BDAT chunk size must be positive");
    }

    const iterator = rechunk(chunks, chunkSize);
    const first = await iterator.next();
    if (first.done) {
      await this.writeCommand("BDAT 0 LAST", signal);
      const response = await this.readReply(signal);
      if (!isSuccess(response.code)) {
        throw this.requireReplyError(response);
      }
      return;
    }

    let current = first.value;
    for (;;) {
      const next = await iterator.next();
      const isLast = next.done;
      await this.writeCommand(`BDAT ${current.byteLength}${isLast ? " LAST" : ""}`, signal);
      await this.writeBlock(current, signal);
      const response = await this.readReply(signal);
      if (!isSuccess(response.code)) {
        throw this.requireReplyError(response);
      }
      if (isLast) {
        return;
      }
      current = next.value;
    }
  }

  private async writePipeline(commands: readonly string[], signal?: AbortSignal): Promise<void> {
    let payload = "";
    for (const command of commands) {
      this.options.debug?.("client", command);
      payload += `${command}\r\n`;
    }
    await this.writeBlock(payload, signal);
  }

  private requireConnection(): LineConnection {
    if (this.connection === undefined) {
      throw new SmtpSessionError(
        smtpSessionErrorKind.noConnection,
        "smtp: no connection established",
      );
    }
    return this.connection;
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new SmtpSessionError(smtpSessionErrorKind.clientClosed, "smtp: client is closed");
    }
  }

  private requireReplyError(response: SmtpResponse): Error {
    return (
      responseError(response) ??
      new SmtpSessionError(
        smtpSessionErrorKind.unexpectedResponse,
        `smtp: unexpected reply ${response.code}`,
      )
    );
  }

  private connectionOptions(): OpenConnectionOptions {
    return {
      host: this.options.host,
      port: this.options.port,
      connectTimeout: this.options.connectTimeout,
      readTimeout: this.options.readTimeout,
      localAddress: this.options.localAddress,
      tls: this.tlsOptions(),
    };
  }

  private tlsOptions(): TlsConnectionOptions {
    const tls: TlsConnectionOptions = { ...this.options.tls };
    if (tls.servername === undefined && isIP(this.options.host) === 0) {
      tls.servername = this.options.host;
    }
    return tls;
  }
}

/** Normalizes a buffer or async iterable into an async iterable of chunks. */
async function* toAsyncChunks(
  data: Uint8Array | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (data instanceof Uint8Array) {
    yield data;
    return;
  }
  yield* data;
}

/** Splits an async chunk stream into pieces no larger than `chunkSize`. */
async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.length; offset += chunkSize) {
      yield chunk.subarray(offset, Math.min(offset + chunkSize, chunk.length));
    }
  }
}

/** Adds a short context label to an unknown thrown value. */
function contextError(error: unknown, label: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`smtp: ${label}: ${message}`, { cause: error });
}
