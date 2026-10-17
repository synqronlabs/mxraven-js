/**
 * Errors raised by the client notification consumer.
 */

/**
 * A failure while connecting to or consuming from the client notification
 * stream.
 *
 * The underlying transport or JetStream failure is available as `cause`. Most
 * connection failures are transient and are retried automatically; this error
 * is only thrown when an operation cannot continue, or when an acknowledgement
 * is attempted after the client was closed.
 *
 * @public
 */
export class NotificationError extends Error {
  /**
   * @param message - A human-readable description.
   * @param options - The optional underlying failure.
   */
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "NotificationError";
  }
}

/**
 * A notification body that does not match the SDK's payload model.
 *
 * This normally means the SDK is older than the server that produced the
 * event. The event is terminated rather than retried, because redelivering it
 * can never succeed. When an error handler is configured, the handler receives
 * the error and consumption continues with the next event; otherwise
 * consumption stops and this error is thrown.
 *
 * @public
 */
export class DecodeError extends NotificationError {
  /** The notification subject the undecodable body was published to. */
  readonly subject: string;

  /**
   * @param options - The notification subject and the underlying failure.
   */
  constructor(options: { readonly subject: string; readonly cause?: unknown }) {
    const detail = options.cause instanceof Error ? `: ${options.cause.message}` : "";
    super(`notify: decode ${JSON.stringify(options.subject)}${detail}`, {
      cause: options.cause,
    });
    this.name = "DecodeError";
    this.subject = options.subject;
  }
}
