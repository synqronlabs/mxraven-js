import type { Result } from "./result.js";

/**
 * An SMTP reply that rejected a submission.
 *
 * It is thrown when the server refuses a command, for example when the sender
 * domain is not authorized or a recipient is rejected. Inspect {@link SMTPError.code}
 * or {@link SMTPError.enhancedCode} to make a delivery decision; the `message`
 * is intended for humans and is not stable.
 *
 * @public
 */
export class SMTPError extends Error {
  /** The three-digit SMTP reply code. */
  readonly code: number;

  /** The RFC 3463 enhanced status code, when the server supplied one. */
  readonly enhancedCode?: string;

  /** @param options - The reply code, optional enhanced code, and reply text. */
  constructor(options: { code: number; enhancedCode?: string; message: string }) {
    super(options.message);
    this.name = "SMTPError";
    this.code = options.code;
    this.enhancedCode = options.enhancedCode;
  }

  /** Reports whether the failure is permanent (5xx). Retrying is unlikely to succeed. */
  get permanent(): boolean {
    return this.code >= 500 && this.code < 600;
  }

  /** Reports whether the failure is transient (4xx). The message may be retried later. */
  get transient(): boolean {
    return this.code >= 400 && this.code < 500;
  }
}

/**
 * A submission the server rejected after per-recipient results were collected.
 *
 * It is thrown when every envelope recipient was rejected. The per-recipient
 * detail remains available in {@link SMTPTransactionError.result}.
 *
 * @public
 */
export class SMTPTransactionError extends Error {
  /** The per-recipient results collected before the failure. */
  readonly result: Result;

  /**
   * @param message - A human-readable description.
   * @param result - The partial submission result.
   */
  constructor(message: string, result: Result) {
    super(message);
    this.name = "SMTPTransactionError";
    this.result = result;
  }
}
