/**
 * A CRLF line-oriented socket connection used by the SMTP session.
 *
 * The connection owns a single TCP or TLS socket, buffers incoming bytes, and
 * resolves one line at a time. Reads and writes are sequential, as SMTP
 * requires; a connection is never used concurrently.
 *
 * @internal
 */

import { Buffer } from "node:buffer";
import { connect as netConnect, type Socket } from "node:net";
import {
  connect as tlsConnect,
  TLSSocket,
  type ConnectionOptions as TlsConnectionOptions,
} from "node:tls";

import {
  SmtpAbortError,
  SmtpSessionError,
  SmtpTimeoutError,
  smtpSessionErrorKind,
} from "./errors.js";

/** Options for a single read or write. */
export interface IoOptions {
  /** Cancels the operation when aborted. */
  readonly signal?: AbortSignal;
  /** The deadline in milliseconds. */
  readonly timeout: number;
  /** A label used in timeout errors. */
  readonly operation: string;
}

/** Options for opening a connection. */
export interface OpenConnectionOptions {
  /** The server host. */
  readonly host: string;
  /** The server port. */
  readonly port: number;
  /** The TCP connect deadline in milliseconds. */
  readonly connectTimeout: number;
  /** The deadline applied to each subsequent read, in milliseconds. */
  readonly readTimeout: number;
  /** A local address to bind to. */
  readonly localAddress?: string;
  /** TLS options for an implicit-TLS connection. */
  readonly tls?: TlsConnectionOptions;
}

/** A line-oriented connection over TCP or TLS. */
export class LineConnection {
  private socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: PendingRead | undefined;
  private failure: Error | undefined;
  private closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    this.attach();
  }

  /** Opens a plain TCP connection. */
  static async openTcp(
    options: OpenConnectionOptions,
    signal?: AbortSignal,
  ): Promise<LineConnection> {
    const socket = netConnect({
      host: options.host,
      port: options.port,
      localAddress: options.localAddress,
    });
    try {
      await waitForReady(socket, "connect", options.connectTimeout, signal, "connect");
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return new LineConnection(socket);
  }

  /** Opens a connection using implicit TLS. */
  static async openTls(
    options: OpenConnectionOptions,
    signal?: AbortSignal,
  ): Promise<LineConnection> {
    const raw = netConnect({
      host: options.host,
      port: options.port,
      localAddress: options.localAddress,
    });
    await waitForReady(raw, "connect", options.connectTimeout, signal, "connect");

    const socket = tlsConnect({ ...options.tls, socket: raw });
    try {
      await waitForReady(socket, "secureConnect", options.connectTimeout, signal, "start TLS");
    } catch (error) {
      raw.destroy();
      throw error;
    }
    return new LineConnection(socket);
  }

  /** Reports whether the connection is protected by TLS. */
  get isTls(): boolean {
    return this.socket instanceof TLSSocket;
  }

  /** Reads one CRLF-terminated line, including its terminator. */
  readLine(options: IoOptions): Promise<string> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (onAbort !== undefined) {
          options.signal?.removeEventListener("abort", onAbort);
        }
      };
      const settle = (settleWith: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (this.pending === pending) {
          this.pending = undefined;
        }
        settleWith();
      };

      const pending: PendingRead = {
        resolve: (line) => settle(() => resolve(line)),
        reject: (error) => settle(() => reject(error)),
      };

      if (options.signal?.aborted === true) {
        settle(() => reject(abortError(options.signal)));
        return;
      }

      timer = setTimeout(
        () => settle(() => reject(new SmtpTimeoutError(options.operation))),
        options.timeout,
      );
      onAbort = () => settle(() => reject(abortError(options.signal)));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending = pending;
      this.drain();
    });
  }

  /** Writes bytes to the connection. */
  write(data: string | Uint8Array, options: IoOptions): Promise<void> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (onAbort !== undefined) {
          options.signal?.removeEventListener("abort", onAbort);
        }
      };
      const settle = (settleWith: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        settleWith();
      };

      if (options.signal?.aborted === true) {
        settle(() => reject(abortError(options.signal)));
        return;
      }

      timer = setTimeout(
        () => settle(() => reject(new SmtpTimeoutError(options.operation))),
        options.timeout,
      );
      onAbort = () => settle(() => reject(abortError(options.signal)));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.socket.write(data, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          settle(() => reject(error));
        } else {
          settle(resolve);
        }
      });
    });
  }

  /** Upgrades the connection to TLS after a successful STARTTLS reply. */
  async upgradeToTls(
    options: TlsConnectionOptions,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.detach();
    const secure = tlsConnect({ ...options, socket: this.socket });
    this.socket = secure;
    this.attach();
    try {
      await waitForReady(secure, "secureConnect", timeout, signal, "start TLS");
    } catch (error) {
      secure.destroy();
      throw error;
    }
  }

  /** Closes the connection. It is safe to call more than once. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detach();
    this.socket.destroy();
  }

  private attach(): void {
    this.socket.on("data", this.handleData);
    this.socket.on("error", this.handleError);
    this.socket.on("close", this.handleClose);
  }

  private detach(): void {
    this.socket.off("data", this.handleData);
    this.socket.off("error", this.handleError);
    this.socket.off("close", this.handleClose);
  }

  private readonly handleData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  };

  private readonly handleError = (error: Error): void => {
    this.fail(error);
  };

  private readonly handleClose = (): void => {
    this.fail(
      new SmtpSessionError(smtpSessionErrorKind.connectionClosed, "smtp: connection closed"),
    );
  };

  private drain(): void {
    const pending = this.pending;
    if (pending === undefined) {
      return;
    }
    const index = this.buffer.indexOf(0x0a);
    if (index < 0) {
      return;
    }
    const line = this.buffer.subarray(0, index + 1).toString("utf8");
    this.buffer = this.buffer.subarray(index + 1);
    this.pending = undefined;
    pending.resolve(line);
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.failure = error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

interface PendingRead {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
}

/** Waits for a socket to finish connecting or handshaking. */
function waitForReady(
  socket: Socket,
  event: "connect" | "secureConnect",
  timeout: number,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const cleanup = (): void => {
      socket.off(event, onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
    };
    const settle = (settleWith: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      settleWith();
    };
    const onReady = (): void => settle(resolve);
    const onError = (error: Error): void => settle(() => reject(error));
    const onClose = (): void =>
      settle(() =>
        reject(
          new SmtpSessionError(
            smtpSessionErrorKind.connectionClosed,
            "smtp: connection closed before it was ready",
          ),
        ),
      );

    if (signal?.aborted === true) {
      settle(() => reject(abortError(signal)));
      return;
    }

    socket.once(event, onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
    timer = setTimeout(() => settle(() => reject(new SmtpTimeoutError(operation))), timeout);
    onAbort = () => settle(() => reject(abortError(signal)));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Builds the error used when an operation observes an aborted signal. */
function abortError(signal: AbortSignal | undefined): Error {
  return new SmtpAbortError({ cause: signal?.reason });
}
