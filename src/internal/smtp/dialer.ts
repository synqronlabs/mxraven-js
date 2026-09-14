/**
 * Establishes fully initialized SMTP sessions.
 *
 * The dialer performs the connection handshake sequence shared by every
 * submission: connect, EHLO, optional STARTTLS with a fresh EHLO, and optional
 * AUTH.
 *
 * @internal
 */

import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

import { SmtpSessionError, smtpSessionErrorKind } from "./errors.js";
import { smtpExtension } from "./extensions.js";
import { SmtpSession, type SmtpAuthOptions, type SmtpSessionOptions } from "./session.js";

/** Configuration for a {@link SmtpDialer}. */
export interface SmtpDialerOptions {
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
  /** Credentials used when the server advertises AUTH. */
  readonly auth?: SmtpAuthOptions;
  /** Upgrades the connection with STARTTLS when the server advertises it. */
  readonly startTls?: boolean;
  /** Fails the dial when STARTTLS is requested but unsupported. */
  readonly requireTls?: boolean;
  /** Connects using implicit TLS instead of STARTTLS. */
  readonly implicitTls?: boolean;
  /** Receives each command and reply line as it is exchanged. */
  readonly debug?: (direction: "client" | "server", line: string) => void;
}

const DEFAULT_LOCAL_NAME = "localhost";
const DEFAULT_CONNECT_TIMEOUT = 30_000;
const DEFAULT_IO_TIMEOUT = 300_000;

/** Opens and initializes SMTP sessions. */
export class SmtpDialer {
  /** The configured host. */
  readonly host: string;
  /** The configured port. */
  readonly port: number;
  /** The EHLO name. */
  readonly localName: string;
  /** The TCP connect deadline in milliseconds. */
  readonly connectTimeout: number;
  /** The per-read deadline in milliseconds. */
  readonly readTimeout: number;
  /** The per-write deadline in milliseconds. */
  readonly writeTimeout: number;

  private readonly options: SmtpDialerOptions;

  constructor(options: SmtpDialerOptions) {
    this.options = options;
    this.host = options.host;
    this.port = options.port;
    this.localName = options.localName ?? DEFAULT_LOCAL_NAME;
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.readTimeout = options.readTimeout ?? DEFAULT_IO_TIMEOUT;
    this.writeTimeout = options.writeTimeout ?? DEFAULT_IO_TIMEOUT;
  }

  /**
   * Opens and initializes a session.
   *
   * On any failure the partially established session is closed before the
   * error is rethrown.
   *
   * @param signal - Cancels the dial.
   * @returns A connected, greeted, and optionally authenticated session.
   */
  async dial(signal?: AbortSignal): Promise<SmtpSession> {
    const session = new SmtpSession(this.sessionOptions());
    try {
      if (this.options.implicitTls === true) {
        await session.connectTls(signal);
      } else {
        await session.connect(signal);
      }

      await session.hello(signal);

      if (this.options.startTls === true && this.options.implicitTls !== true) {
        if (session.hasExtension(smtpExtension.startTls)) {
          await session.startTls(signal);
          await session.hello(signal);
        } else if (this.options.requireTls === true) {
          throw new SmtpSessionError(
            smtpSessionErrorKind.tlsNotSupported,
            "smtp: server does not support STARTTLS",
          );
        }
      }

      if (this.options.auth !== undefined) {
        await session.auth(signal);
      }
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  private sessionOptions(): SmtpSessionOptions {
    return {
      host: this.host,
      port: this.port,
      localName: this.localName,
      localAddress: this.options.localAddress,
      connectTimeout: this.connectTimeout,
      readTimeout: this.readTimeout,
      writeTimeout: this.writeTimeout,
      tls: this.options.tls,
      auth: this.options.auth,
      debug: this.options.debug,
    };
  }
}
