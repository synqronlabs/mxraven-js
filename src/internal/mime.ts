/**
 * MIME serialization helpers.
 *
 * This module is internal to the SDK. It builds the `multipart/alternative` and `multipart/mixed`
 * bodies that the {@link Message} builder emits, and formats attachment parts with Base64 transfer
 * encoding.
 *
 * @internal
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { containsNonAscii } from "./address.js";

/** A fully rendered body with its content headers. */
export interface BodyPart {
  /** The `Content-Type` field value. */
  readonly contentType: string;
  /** The `Content-Transfer-Encoding` field value. */
  readonly contentTransferEncoding: string;
  /** The body, already normalized to CRLF line endings. */
  readonly data: string;
}

/** A rendered MIME entity. */
export interface MultipartResult {
  /** The `Content-Type` field value, including the boundary parameter. */
  readonly contentType: string;
  /** The `Content-Transfer-Encoding` field value. */
  readonly contentTransferEncoding: string;
  /** The rendered body. */
  readonly data: string;
}

/** An attachment to render into a `multipart/mixed` body. */
export interface MimeAttachment {
  /** The filename, when one should be advertised. */
  readonly filename?: string;
  /** The media type. */
  readonly contentType: string;
  /** The raw attachment bytes. */
  readonly data: Uint8Array;
  /** Whether the part is inline rather than a downloadable attachment. */
  readonly inline?: boolean;
  /** The inline content identifier, without angle brackets. */
  readonly contentId?: string;
}

/** Converts LF and bare CR line endings to CRLF. */
export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

/** Appends a trailing CRLF when the value does not already end with one. */
function ensureTrailingCrlf(value: string): string {
  return value.endsWith("\r\n") ? value : `${value}\r\n`;
}

/** Encodes bytes as Base64 wrapped at 76 characters with CRLF line endings. */
export function encodeBase64Lines(data: Uint8Array): string {
  if (data.length === 0) {
    return "";
  }
  const encoded = Buffer.from(data).toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Builds a `multipart/alternative` body from plain-text and HTML sources. */
export function buildMultipartAlternative(text: string, html: string): MultipartResult {
  const encoding = containsNonAscii(text) || containsNonAscii(html) ? "8bit" : "7bit";
  const boundary = generateBoundary();

  const parts: string[] = [];
  parts.push(renderTextPart(boundary, "text/plain; charset=utf-8", encoding, text));
  parts.push(renderTextPart(boundary, "text/html; charset=utf-8", encoding, html));
  parts.push(`--${boundary}--\r\n`);

  return {
    contentType: `multipart/alternative; boundary="${boundary}"`,
    contentTransferEncoding: encoding,
    data: parts.join(""),
  };
}

/**
 * Wraps a body and its attachments into a `multipart/mixed` body.
 *
 * The body part is emitted first, followed by one part per attachment. The caller is responsible
 * for removing the original body-level content headers, as required by MIME.
 */
export function wrapAttachments(
  body: BodyPart,
  attachments: readonly MimeAttachment[],
): MultipartResult {
  const boundary = generateBoundary();
  const parts: string[] = [];

  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Type: ${body.contentType}\r\n`);
  parts.push(`Content-Transfer-Encoding: ${body.contentTransferEncoding}\r\n`);
  parts.push("\r\n");
  parts.push(ensureTrailingCrlf(body.data));

  for (const attachment of attachments) {
    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Type: ${attachment.contentType}\r\n`);
    parts.push("Content-Transfer-Encoding: base64\r\n");
    const disposition = attachment.inline === true ? "inline" : "attachment";
    parts.push(`Content-Disposition: ${formatDisposition(disposition, attachment.filename)}\r\n`);
    if (attachment.contentId !== undefined && attachment.contentId !== "") {
      parts.push(`Content-ID: <${attachment.contentId}>\r\n`);
    }
    parts.push("\r\n");
    parts.push(encodeBase64Lines(attachment.data));
  }

  parts.push(`--${boundary}--\r\n`);

  return {
    contentType: `multipart/mixed; boundary="${boundary}"`,
    contentTransferEncoding: "7bit",
    data: parts.join(""),
  };
}

/** Renders one text part of a multipart body. */
function renderTextPart(
  boundary: string,
  contentType: string,
  encoding: string,
  body: string,
): string {
  return (
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `Content-Transfer-Encoding: ${encoding}\r\n` +
    "\r\n" +
    ensureTrailingCrlf(normalizeLineEndings(body))
  );
}

/** Formats a `Content-Disposition` value with an optional filename. */
function formatDisposition(disposition: string, filename: string | undefined): string {
  if (filename === undefined || filename === "") {
    return disposition;
  }
  if (containsNonAscii(filename)) {
    return `${disposition}; filename*=utf-8''${encodeRfc2231(filename)}`;
  }
  const quoted = filename.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${disposition}; filename="${quoted}"`;
}

/** Percent-encodes a value for an RFC 2231 extended parameter. */
function encodeRfc2231(value: string): string {
  let output = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(char)) {
      output += char;
    } else {
      output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return output;
}

/** Generates a random MIME boundary. */
function generateBoundary(): string {
  return `----=_mxraven_${randomBytes(16).toString("hex")}`;
}
