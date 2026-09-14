/**
 * RFC 5322 header field validation, folding, and serialization.
 *
 * This module is internal to the SDK.
 *
 * @internal
 */

/** A single message header field. */
export interface HeaderField {
  /** The field name, for example `Subject`. */
  readonly name: string;
  /** The field value. It must not contain line breaks. */
  readonly value: string;
}

/** The recommended maximum line length for header fields. */
const RECOMMENDED_LINE_LENGTH = 78;

/**
 * Validates a header field name.
 *
 * @throws `Error` when the name is empty or contains characters outside the `ftext` set defined by
 *   RFC 5322.
 * @internal
 */
export function validateHeaderName(name: string): void {
  if (!/^[!-9;-~]+$/.test(name)) {
    throw new Error(`mail: invalid header name: ${JSON.stringify(name)}`);
  }
}

/**
 * Validates a header field value.
 *
 * @throws `Error` when the value contains a line break or a control character.
 * @internal
 */
export function validateHeaderValue(value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error("mail: header value contains a line break");
  }
  if (hasControlCharacter(value)) {
    throw new Error("mail: header value contains a control character");
  }
}

/** Reports whether a value contains a control character other than tab. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a header field.
 *
 * @throws `Error` when the name or value is invalid.
 * @internal
 */
export function validateHeader(name: string, value: string): void {
  validateHeaderName(name);
  validateHeaderValue(value);
}

/** Returns the first value for a header name, compared case-insensitively. */
export function getHeader(headers: readonly HeaderField[], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (header.name.toLowerCase() === lower) {
      return header.value;
    }
  }
  return undefined;
}

/**
 * Serializes header fields into a CRLF-terminated header block.
 *
 * Long values are folded at whitespace near the recommended line length. A value that contains no
 * whitespace is never split, so encodings such as RFC 2047 encoded words survive intact.
 *
 * @internal
 */
export function serializeHeaders(headers: readonly HeaderField[]): string {
  let output = "";
  for (const header of headers) {
    output += foldHeader(header.name, header.value);
  }
  return output;
}

/** Folds a single header field at whitespace near the recommended line length. */
function foldHeader(name: string, value: string): string {
  const prefix = `${name}: `;
  if (prefix.length + value.length <= RECOMMENDED_LINE_LENGTH) {
    return `${prefix}${value}\r\n`;
  }

  const words = value.split(/[ \t]+/).filter((word) => word !== "");
  const lines: string[] = [];
  let current = `${name}:`;
  let hasWord = false;

  for (const word of words) {
    const candidate = `${current} ${word}`;
    if (hasWord && candidate.length > RECOMMENDED_LINE_LENGTH) {
      lines.push(current);
      current = ` ${word}`;
    } else {
      current = candidate;
      hasWord = true;
    }
  }

  lines.push(current);
  return `${lines.join("\r\n")}\r\n`;
}
