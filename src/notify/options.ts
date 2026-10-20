/**
 * Options and handler contracts for the client notification consumer.
 */

import type { NotificationError } from "./errors.js";
import type { NotificationEvent } from "./event.js";

/**
 * TLS options for a `wss://` notification connection.
 *
 * These are the options applications normally need when the notification tier
 * is fronted by a private certificate authority or requires mutual TLS. Byte
 * material may be a PEM string or raw bytes.
 *
 * @public
 */
export interface NotificationTlsOptions {
  /** PEM-encoded CA certificate(s) used to verify the server. */
  readonly ca?: string | Uint8Array | readonly (string | Uint8Array)[];
  /** PEM-encoded client certificate for mutual TLS. */
  readonly cert?: string | Uint8Array;
  /** PEM-encoded client private key for mutual TLS. */
  readonly key?: string | Uint8Array;
  /** The passphrase for an encrypted client private key. */
  readonly passphrase?: string;
  /**
   * Whether to verify the server certificate chain and hostname.
   *
   * Defaults to `true`. Disabling it makes the connection vulnerable to
   * interception and should only be used in controlled development
   * environments.
   */
  readonly rejectUnauthorized?: boolean;
  /** The SNI server name, when it differs from the URL host. */
  readonly servername?: string;
}

/** Options for {@link NotificationClient.connect}. @public */
export interface NotificationClientOptions {
  /**
   * The client notification tier WebSocket URL, for example
   * `wss://notifications.mxraven.com`. Only the `ws:` and `wss:` schemes are accepted.
   */
  readonly url: string;
  /**
   * The listener API key prefix, for example `mxr_tx_ab12cd34ef56`.
   *
   * The notification tier authenticates with the same API key used for SMTP
   * submission and recipient feedback.
   */
  readonly username: string;
  /** The listener API key secret. Treat it as a secret and do not log it. */
  readonly secret: string;
  /**
   * The listener whose events are consumed.
   *
   * It is used to derive the durable consumer name and the per-listener inbox
   * prefix, so it must not contain `.`, `*`, `>`, `/`, `\`, or whitespace.
   */
  readonly listener: string;
  /**
   * Overrides the durable consumer name.
   *
   * Defaults to `notify-<listener>`, which is the name the control plane
   * creates when notifications are enabled. Set it only when binding to a
   * consumer name reported by the control plane.
   */
  readonly consumer?: string;
  /** TLS options used for a `wss://` connection. */
  readonly tls?: NotificationTlsOptions;
  /** The deadline for establishing the connection, in milliseconds. Defaults to 10000. */
  readonly connectTimeout?: number;
  /**
   * Receives non-fatal connection and decode errors.
   *
   * Decode errors normally stop consumption because the same event would be
   * redelivered forever. When this handler is set, it takes responsibility for
   * the undecodable event and consumption continues. Connection errors are
   * reported here while the transport reconnects automatically.
   *
   * The handler runs on the consuming task and must return promptly. Do not
   * throw from it; exceptions are ignored to keep the connection usable.
   */
  readonly onError?: (error: NotificationError) => void;
}

/** Context passed to a notification handler. @public */
export interface NotificationContext {
  /** Aborts when the caller cancels consumption or closes the client. */
  readonly signal: AbortSignal;
}

/**
 * Returned from a notification handler to acknowledge the current event and
 * stop consuming.
 *
 * The sentinel is distinct from `undefined`, which acknowledges the event and
 * continues with the next one.
 *
 * @public
 */
export const stopConsuming: unique symbol = Symbol("mxraven.mail.notify.stopConsuming");

/** The value a notification handler may return. @public */
export type NotificationHandlerResult = void | typeof stopConsuming;

/**
 * Processes one notification event.
 *
 * Returning normally acknowledges the event. Throwing leaves it unacknowledged
 * so the server redelivers it with exponential backoff, capped at 30 seconds.
 * Returning {@link stopConsuming} acknowledges the event and stops consumption.
 *
 * @public
 */
export type NotificationHandler = (
  event: NotificationEvent,
  context: NotificationContext,
) => NotificationHandlerResult | Promise<NotificationHandlerResult>;

/** Options for {@link NotificationClient.consume}. @public */
export interface ConsumeOptions {
  /** Cancels consumption. Cancellation is a normal stop, not an error. */
  readonly signal?: AbortSignal;
}

/** Options for {@link NotificationClient.events}. @public */
export interface EventsOptions {
  /** Cancels iteration. Cancellation is a normal stop, not an error. */
  readonly signal?: AbortSignal;
}
