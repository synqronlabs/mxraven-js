/**
 * A non-success response from the feedback service.
 *
 * @public
 */
export class FeedbackError extends Error {
  /** The HTTP response status. */
  readonly statusCode: number;

  /**
   * The service's error message when one was returned, otherwise the HTTP
   * status text.
   */
  readonly detail: string;

  /**
   * @param options - The response status and service error message.
   */
  constructor(options: { statusCode: number; detail: string }) {
    super(
      options.detail === ""
        ? `feedback: request failed with status ${options.statusCode}`
        : `feedback: request failed with status ${options.statusCode}: ${options.detail}`,
    );
    this.name = "FeedbackError";
    this.statusCode = options.statusCode;
    this.detail = options.detail;
  }

  /**
   * Reports whether the request may succeed if retried later.
   *
   * Rate limits (429) and server-side failures (5xx) are retryable.
   */
  get retryable(): boolean {
    return this.statusCode === 429 || this.statusCode >= 500;
  }
}
