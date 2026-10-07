/**
 * Inbound email parsing for mxRaven deliveries.
 *
 * mxRaven webhook payloads describe inbound mail as JSON, and the full message
 * remains available as raw RFC 5322 bytes behind the payload's `raw_email`
 * reference. {@link parseEmail} turns those bytes into headers, addresses,
 * bodies, and decoded attachments; {@link fetchAndParseRawEmail} downloads,
 * verifies, and parses them in one step:
 *
 * ```ts
 * import { Verifier, eventType } from "@mxraven/mail/webhook";
 * import { fetchAndParseRawEmail } from "@mxraven/mail/mime";
 *
 * const verifier = new Verifier({ secret });
 * const event = await verifier.verifyAndDecode(request);
 *
 * if (event.type === eventType.inboundEmail) {
 *   const email = await fetchAndParseRawEmail(event.inboundEmail.raw_email);
 *   console.log(email.subject, email.attachments.length);
 * }
 * ```
 *
 * The parser is defensive: malformed messages yield the best available
 * interpretation instead of an error, and unknown charsets fall back to UTF-8
 * and then Latin-1. It understands `multipart/mixed`, `multipart/alternative`,
 * and `multipart/related`, decodes `base64` and `quoted-printable` transfer
 * encodings, decodes RFC 2047 encoded words, and reassembles RFC 2231
 * parameters. `message/rfc822` parts are surfaced as attachments rather than
 * parsed recursively. Only unbounded input — very deep nesting or thousands of
 * parts — is rejected.
 *
 * @packageDocumentation
 */

import type { RawEmail } from "../webhook/payload.js";
import { fetchRawEmail, type FetchRawEmailOptions } from "../webhook/raw.js";
import { parseEmail } from "./parse.js";
import type { ParsedEmail } from "./parse.js";

export { parseEmail };
export type { ParsedAddress, ParsedAttachment, ParsedEmail, ParsedHeader } from "./parse.js";

/**
 * Downloads the raw message referenced by an inbound-email payload and parses
 * it.
 *
 * The download verifies the declared size and SHA-256 digest and is bounded
 * exactly like {@link fetchRawEmail}; the payload's short-lived bearer token is
 * sent in the `Authorization` header and must not be logged.
 *
 * @param raw - The `raw_email` object from an inbound-email webhook payload.
 * @param options - An optional cancellation signal and `fetch` implementation.
 * @returns The parsed message. All returned byte arrays are fresh copies.
 * @throws `Error` When the download fails or the message exceeds the parser's
 * nesting or part limits.
 *
 * @example
 * ```ts
 * const email = await fetchAndParseRawEmail(event.inboundEmail.raw_email, { signal });
 * for (const attachment of email.attachments) {
 *   console.log(attachment.filename, attachment.content.byteLength);
 * }
 * ```
 *
 * @public
 */
export async function fetchAndParseRawEmail(
  raw: RawEmail,
  options: FetchRawEmailOptions = {},
): Promise<ParsedEmail> {
  return parseEmail(await fetchRawEmail(raw, options));
}
