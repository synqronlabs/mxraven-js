/**
 * The NATS JetStream connection behind the notification client.
 *
 * @internal
 */

import { Buffer } from "node:buffer";

import { jetstream, type Consumer, type ConsumerMessages } from "@nats-io/jetstream";
import {
  wsconnect,
  type NatsConnection,
  type WsConnectionOptions,
  type WsSocketFactory,
} from "@nats-io/nats-core";
import WsSocket from "ws";

import { NotificationError } from "./errors.js";
import type { NotificationTlsOptions } from "./options.js";

/** The `ws` client options accepted by the WebSocket factory. */
type WsClientOptions = WsSocket.ClientOptions;

/** The stream that carries client notification events. */
const STREAM_NAME = "CLIENT_NOTIFY";

/** The client name the notification tier sees. */
const CLIENT_NAME = "mxraven-notify";

/** The validated options a connection needs. */
export interface NotifyConnectionOptions {
  readonly url: string;
  readonly username: string;
  readonly secret: string;
  readonly listener: string;
  readonly consumer: string;
  readonly tls?: NotificationTlsOptions;
  readonly connectTimeout: number;
  readonly onError?: (error: NotificationError) => void;
}

/**
 * Owns one NATS connection and the listener's durable consumer.
 *
 * The transport reconnects indefinitely. A consumer loop ends when the caller
 * stops it or the client closes; a transport that closes permanently is
 * reported through {@link terminalError}.
 *
 * @internal
 */
export class NotifyConnection {
  private readonly nc: NatsConnection;
  private readonly consumer: Consumer;
  private readonly errorHandler: ((error: NotificationError) => void) | undefined;
  private userClosed = false;
  private terminal: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly closeController = new AbortController();

  private constructor(
    nc: NatsConnection,
    consumer: Consumer,
    errorHandler: ((error: NotificationError) => void) | undefined,
  ) {
    this.nc = nc;
    this.consumer = consumer;
    this.errorHandler = errorHandler;
    void this.observeClosed();
    void this.observeStatus();
  }

  /**
   * Connects to the notification tier and resolves the listener's consumer.
   *
   * @param options - The validated connection options.
   * @returns A connected client.
   * @throws {@link NotificationError} When the connection or consumer lookup
   * fails.
   *
   * @internal
   */
  static async open(options: NotifyConnectionOptions): Promise<NotifyConnection> {
    const natsOptions: WsConnectionOptions = {
      servers: options.url,
      user: options.username,
      pass: options.secret,
      name: CLIENT_NAME,
      // The callout grants exactly this per-listener inbox prefix.
      inboxPrefix: `_INBOX.${options.listener}`,
      timeout: options.connectTimeout,
      reconnect: true,
      maxReconnectAttempts: -1,
      wsFactory: createWsFactory(options.tls, options.connectTimeout),
    };

    let nc: NatsConnection;
    try {
      nc = await wsconnect(natsOptions);
    } catch (cause) {
      throw new NotificationError("notify: connect", { cause });
    }

    try {
      const consumer = await jetstream(nc).consumers.get(STREAM_NAME, options.consumer);
      return new NotifyConnection(nc, consumer, options.onError);
    } catch (cause) {
      await nc.close().catch(() => undefined);
      throw new NotificationError(`notify: resolve consumer ${JSON.stringify(options.consumer)}`, {
        cause,
      });
    }
  }

  /** Reports whether the caller closed the client. */
  get isClosed(): boolean {
    return this.userClosed;
  }

  /** Reports whether a non-fatal error handler is configured. */
  get hasErrorHandler(): boolean {
    return this.errorHandler !== undefined;
  }

  /** Aborts when the caller closes the client. */
  get closedSignal(): AbortSignal {
    return this.closeController.signal;
  }

  /** Starts one pull consumer over this listener's durable consumer. */
  async messages(): Promise<ConsumerMessages> {
    try {
      return await this.consumer.consume({
        max_messages: 1,
        // A deleted consumer would otherwise be retried forever. The Go SDK
        // surfaces the missing consumer instead.
        abort_on_missing_resource: true,
      });
    } catch (error) {
      throw this.wrap("notify: start consume", error);
    }
  }

  /**
   * Returns the terminal transport error, when the connection closed on its own.
   *
   * A user-initiated close is not an error.
   */
  terminalError(): NotificationError | undefined {
    if (this.userClosed || this.terminal === undefined) {
      return undefined;
    }
    return this.wrap("notify: connection closed", this.terminal);
  }

  /** Forwards a non-fatal error to the configured handler. */
  report(error: NotificationError): void {
    const handler = this.errorHandler;
    if (handler === undefined) {
      return;
    }
    try {
      handler(error);
    } catch {
      // The callback contract says not to throw. Keeping the transport alive is
      // more useful than tearing it down from an error reporter.
    }
  }

  /** Adds operation context to an arbitrary failure. */
  wrap(operation: string, error: unknown): NotificationError {
    if (error instanceof NotificationError) {
      return error;
    }
    return new NotificationError(operation, { cause: error });
  }

  /** Closes the connection. It is safe to call more than once. */
  close(): Promise<void> {
    this.userClosed = true;
    this.closeController.abort();
    this.closePromise ??= this.nc.close().then(
      () => undefined,
      (cause: unknown) => {
        throw new NotificationError("notify: close", { cause });
      },
    );
    return this.closePromise;
  }

  /** Records a terminal close so active consumers can stop with its reason. */
  private async observeClosed(): Promise<void> {
    const error = await this.nc.closed();
    if (error !== undefined) {
      this.terminal = error;
    }
  }

  /** Drains connection statuses and reports transport-level errors. */
  private async observeStatus(): Promise<void> {
    try {
      for await (const status of this.nc.status()) {
        if (status.type === "error") {
          this.report(this.wrap("notify: connection", status.error));
        }
      }
    } catch (error) {
      this.report(this.wrap("notify: connection status", error));
    }
  }
}

/** Builds the `ws` factory that lets nats-core run on Node 20. */
function createWsFactory(
  tls: NotificationTlsOptions | undefined,
  connectTimeout: number,
): WsSocketFactory {
  const wsOptions: WsClientOptions & { servername?: string } = {
    perMessageDeflate: false,
    handshakeTimeout: connectTimeout,
  };
  if (tls !== undefined) {
    wsOptions.ca = keyMaterial(tls.ca);
    wsOptions.cert = keyMaterial(tls.cert);
    wsOptions.key = keyMaterial(tls.key);
    wsOptions.passphrase = tls.passphrase;
    wsOptions.rejectUnauthorized = tls.rejectUnauthorized;
    wsOptions.servername = tls.servername;
  }

  return async (url) => {
    const socket = new WsSocket(url, wsOptions);
    return {
      // `ws` implements the W3C WebSocket surface nats-core uses: event
      // handlers, `binaryType`, `send`, and `close`.
      socket: socket as unknown as InstanceType<typeof globalThis.WebSocket>,
      encrypted: url.startsWith("wss://"),
    };
  };
}

/** Converts the public TLS byte material to what `ws` accepts. */
function keyMaterial(
  value: string | Uint8Array | readonly (string | Uint8Array)[] | undefined,
): string | Buffer | Array<string | Buffer> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return value.map((entry) => (typeof entry === "string" ? entry : Buffer.from(entry)));
}
