import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

import { SMTPTransactionError } from "./errors.js";
import { parseAddress } from "./internal/address.js";
import { SmtpDialer } from "./internal/smtp/dialer.js";
import { SmtpTransactionError as InternalTransactionError } from "./internal/smtp/errors.js";
import { SmtpPool } from "./internal/smtp/pool.js";
import type { SmtpEnvelope, TransactionResult } from "./internal/smtp/transaction.js";
import { Message, type BuiltMessage, type Envelope } from "./message.js";
import { parseMessageRef, type Result } from "./result.js";

/** The default mxRaven SMTP submission port. */
export const defaultAddressPort = 587;

/** Options for a {@link Client}. */
export interface ClientOptions {
  /** The submission server host. A port must not be included. */
  readonly host: string;
  /** The submission server port. Defaults to {@link defaultAddressPort}. */
  readonly port?: number;
  /** The submission API key username, for example `mxr_tx_ab12cd34ef56`. */
  readonly username: string;
  /** The submission API key secret. */
  readonly secret: string;
  /** STARTTLS options, for example a custom CA or `servername`. */
  readonly tls?: TlsConnectionOptions;
  /** The maximum number of pooled connections. Defaults to 5. */
  readonly poolSize?: number;
  /** The TCP connect deadline in milliseconds. Defaults to 30000. */
  readonly connectTimeout?: number;
  /** The per-read deadline in milliseconds. Defaults to 300000. */
  readonly readTimeout?: number;
  /** The per-write deadline in milliseconds. Defaults to 300000. */
  readonly writeTimeout?: number;
  /** The name sent in EHLO. Defaults to `localhost`. */
  readonly localName?: string;
}

/** Per-call options for {@link Client.send} and {@link Client.sendRaw}. */
export interface SendOptions {
  /** Cancels the submission. */
  readonly signal?: AbortSignal;
}

const DEFAULT_POOL_SIZE = 5;

/**
 * Submits mail to the mxRaven SMTP submission service.
 *
 * A client maintains a bounded pool of authenticated connections and is safe
 * for concurrent use. The submission service requires STARTTLS and SMTP AUTH,
 * so both are always used.
 *
 * @example
 * ```ts
 * const secret = process.env.MXRAVEN_SECRET;
 * if (secret === undefined || secret === "") {
 *   throw new Error("MXRAVEN_SECRET is required");
 * }
 *
 * const client = new Client({
 *   host: "smtp.mxraven.com",
 *   username: "mxr_tx_ab12cd34ef56",
 *   secret,
 * });
 * const result = await client.send(
 *   new Message().from("noreply@acme.example").to("customer@example.com").text("Hi"),
 * );
 * await client.close();
 * ```
 *
 * @public
 */
export class Client {
  private readonly pool: SmtpPool;

  /**
   * @param options - The server address, credentials, and tuning options.
   * @throws `Error` When required options are missing or invalid.
   */
  constructor(options: ClientOptions) {
    const port = options.port ?? defaultAddressPort;
    if (options.host.trim() === "") {
      throw new Error("mail: server host is required");
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`mail: invalid server port ${port}`);
    }
    if (options.username.trim() === "") {
      throw new Error("mail: username must not be empty");
    }
    if (options.secret === "") {
      throw new Error("mail: secret must not be empty");
    }
    if (
      options.poolSize !== undefined &&
      (!Number.isInteger(options.poolSize) || options.poolSize <= 0)
    ) {
      throw new Error(`mail: invalid pool size ${options.poolSize}`);
    }

    const dialer = new SmtpDialer({
      host: options.host,
      port,
      localName: options.localName,
      connectTimeout: options.connectTimeout,
      readTimeout: options.readTimeout,
      writeTimeout: options.writeTimeout,
      tls: options.tls,
      auth: { username: options.username, password: options.secret },
      startTls: true,
      requireTls: true,
    });
    this.pool = new SmtpPool({
      dialer,
      size: options.poolSize ?? DEFAULT_POOL_SIZE,
    });
  }

  /**
   * Sends a composed message.
   *
   * @param message - The message to submit. It may be sent more than once.
   * @param options - An optional cancellation signal.
   * @returns The server's result for the submission.
   * @throws {@link SMTPError} When the server rejects a command.
   * @throws {@link SMTPTransactionError} When every recipient is rejected; the
   * per-recipient detail is on {@link SMTPTransactionError.result}.
   *
   * @public
   */
  async send(message: Message, options: SendOptions = {}): Promise<Result> {
    if (!(message instanceof Message)) {
      throw new Error("mail: message is required");
    }
    const built = message.build();
    return this.transact(
      (signal) => this.pool.send(this.toEnvelope(built), built.data, {}, signal),
      options.signal,
    );
  }

  /**
   * Streams an already serialized RFC 5322 message with an explicit envelope.
   *
   * The message is not parsed, so the caller is responsible for RFC 5322
   * correctness. Prefer this for large or pre-rendered messages.
   *
   * @param envelope - The SMTP envelope, independent of the message headers.
   * @param data - The raw message bytes, or an async stream of chunks.
   * @param options - An optional cancellation signal.
   * @returns The server's result for the submission.
   * @throws {@link SMTPError} When the server rejects a command.
   * @throws {@link SMTPTransactionError} When every recipient is rejected.
   *
   * @public
   */
  async sendRaw(
    envelope: Envelope,
    data: Uint8Array | AsyncIterable<Uint8Array>,
    options: SendOptions = {},
  ): Promise<Result> {
    const smtpEnvelope = this.envelopeFromPublic(envelope);
    return this.transact(
      (signal) => this.pool.sendRaw(smtpEnvelope, data, {}, signal),
      options.signal,
    );
  }

  /** Releases the pooled connections. It is safe to call more than once. */
  async close(): Promise<void> {
    await this.pool.close();
  }

  private async transact(
    run: (signal?: AbortSignal) => Promise<TransactionResult>,
    signal?: AbortSignal,
  ): Promise<Result> {
    try {
      return toResult(await run(signal));
    } catch (error) {
      throw translateError(error);
    }
  }

  private toEnvelope(built: BuiltMessage): SmtpEnvelope {
    return {
      from: built.from,
      recipients: built.recipients.map((address) => ({ address })),
      size: built.size,
      smtpUtf8: built.smtpUtf8,
    };
  }

  private envelopeFromPublic(envelope: Envelope): SmtpEnvelope {
    const from =
      envelope.from === undefined || envelope.from.trim() === ""
        ? undefined
        : parseAddress(envelope.from);
    return {
      from,
      recipients: envelope.to.map((address) => ({ address: parseAddress(address) })),
    };
  }
}

/** Converts an internal transaction result into the public result. */
function toResult(transaction: TransactionResult): Result {
  const response = transaction.response;
  return {
    messageRef: response === undefined ? "" : parseMessageRef(response.message),
    code: response?.code ?? 0,
    message: response?.message ?? "",
    recipients: transaction.recipients.map((recipient) => ({
      address: recipient.address,
      accepted: recipient.accepted,
      error: recipient.error,
    })),
  };
}

/** Maps internal failures onto the public error surface. */
function translateError(error: unknown): Error {
  if (error instanceof InternalTransactionError) {
    return new SMTPTransactionError(error.message, toResult(error.result));
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
