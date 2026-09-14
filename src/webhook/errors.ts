/**
 * A webhook signature did not match the request.
 *
 * @public
 */
export class InvalidSignatureError extends Error {
  /**
   * @param message - A human-readable description.
   */
  constructor(message = "webhook: invalid signature") {
    super(message);
    this.name = "InvalidSignatureError";
  }
}
