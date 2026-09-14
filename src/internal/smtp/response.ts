/**
 * SMTP reply parsing.
 *
 * @internal
 */

import { SMTPError } from "../../errors.js";

/** A parsed SMTP reply. */
export interface SmtpResponse {
  /** The three-digit reply code. */
  readonly code: number;
  /** The reply text, with continuation lines joined by `\n`. */
  readonly message: string;
  /** The reply text lines, without codes. */
  readonly lines: readonly string[];
  /** The RFC 3463 enhanced status code, when present. */
  readonly enhancedCode: string;
}

/** Reports whether a reply code indicates success (2xx). */
export function isSuccess(code: number): boolean {
  return code >= 200 && code < 300;
}

/** Reports whether a reply code indicates an intermediate reply (3xx). */
export function isIntermediate(code: number): boolean {
  return code >= 300 && code < 400;
}

/** Reports whether a reply code indicates a transient failure (4xx). */
export function isTransient(code: number): boolean {
  return code >= 400 && code < 500;
}

/** Reports whether a reply code indicates a permanent failure (5xx). */
export function isPermanent(code: number): boolean {
  return code >= 500 && code < 600;
}

/**
 * Converts a non-success reply into an {@link SMTPError}.
 *
 * @param response - The reply to inspect.
 * @returns An error for 4xx and 5xx replies, or `undefined` for 2xx and 3xx.
 */
export function responseError(response: SmtpResponse): SMTPError | undefined {
  if (isSuccess(response.code) || isIntermediate(response.code)) {
    return undefined;
  }
  return new SMTPError({
    code: response.code,
    enhancedCode: response.enhancedCode === "" ? undefined : response.enhancedCode,
    message: response.message,
  });
}

/**
 * Extracts an RFC 3463 enhanced status code from the start of a reply text.
 *
 * @param message - The first line of a reply.
 * @returns The `X.Y.Z` code, or an empty string when the text does not start
 * with a valid code.
 */
export function parseEnhancedCode(message: string): string {
  if (message.length < 5) {
    return "";
  }
  const token = message.split(" ", 1)[0] ?? "";
  const parts = token.split(".");
  if (parts.length !== 3) {
    return "";
  }
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return "";
    }
  }
  return token;
}
