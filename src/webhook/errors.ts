/**
 * Webhook errors.
 *
 * Every error thrown while handling a webhook request is a {@link WebhookError}
 * carrying the HTTP status an adapter should respond with, so framework
 * integration never has to branch on error messages.
 */

/** The HTTP status a webhook handler responds with. */
export type WebhookStatus = 200 | 204 | 400 | 401 | 413 | 500;

/**
 * A webhook request failure with an associated HTTP status.
 *
 * @public
 */
export class WebhookError extends Error {
  /** The HTTP status that reports this failure. */
  readonly status: WebhookStatus;

  /**
   * @param message - A human-readable description.
   * @param status - The HTTP status that reports this failure.
   * @param cause - The error being wrapped, when any.
   */
  constructor(message: string, status: WebhookStatus, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WebhookError";
    this.status = status;
  }
}

/**
 * A webhook signature did not match the request.
 *
 * @public
 */
export class InvalidSignatureError extends WebhookError {
  /**
   * @param message - A human-readable description.
   */
  constructor(message = "webhook: invalid signature") {
    super(message, 401);
    this.name = "InvalidSignatureError";
  }
}

/**
 * A webhook request was malformed, for example missing signature headers, a
 * stale timestamp, or a payload that is not valid JSON.
 *
 * @public
 */
export class WebhookRequestError extends WebhookError {
  /**
   * @param message - A human-readable description.
   * @param cause - The error being wrapped, when any.
   */
  constructor(message: string, cause?: unknown) {
    super(message, 400, cause);
    this.name = "WebhookRequestError";
  }
}

/**
 * A webhook request body exceeded the configured limit.
 *
 * @public
 */
export class PayloadTooLargeError extends WebhookError {
  /**
   * @param message - A human-readable description.
   */
  constructor(message: string) {
    super(message, 413);
    this.name = "PayloadTooLargeError";
  }
}
