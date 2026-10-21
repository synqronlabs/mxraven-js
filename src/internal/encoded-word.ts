/**
 * RFC 2047 encoded-word decoding.
 *
 * This module is internal to the SDK. It decodes the `encoded-word` tokens that
 * may appear in a structured header value such as a display name, and is
 * deliberately strict about the character sets it can interpret.
 *
 * @remarks
 * The decoder mirrors the semantics of Go's `mime.WordDecoder.DecodeHeader`: a
 * malformed encoded-word is passed through verbatim, whitespace between two
 * adjacent encoded-words is removed, `us-ascii` bytes outside the range are
 * replaced with U+FFFD, and any other character set is resolved through the
 * platform's `TextDecoder`, which follows the WHATWG label registry — so
 * `iso-8859-1` is decoded as its windows-1252 superset, as real-world mail
 * expects. Two deliberate differences remain: invalid UTF-8 is replaced with
 * U+FFFD because JavaScript strings cannot represent invalid UTF-8, and a
 * character set that the platform does not know is reported rather than
 * guessed.
 *
 * @internal
 */

import { Buffer } from "node:buffer";

/** The longest encoded-word this module accepts. */
const MAX_ENCODED_WORD = 998;

/**
 * Decodes every RFC 2047 encoded-word in a header value.
 *
 * Whitespace separating two adjacent encoded-words is removed, as required by
 * RFC 2047 section 6.2. Text that is not a syntactically valid encoded-word is
 * preserved unchanged.
 *
 * @param value - The header text to decode.
 * @returns The decoded text, or `undefined` when the value uses a character set
 * that this decoder cannot interpret.
 *
 * @internal
 */
export function decodeHeaderWords(value: string): string | undefined {
  let cursor = 0;
  let output = "";
  let previousWasEncoded = false;

  for (;;) {
    const start = value.indexOf("=?", cursor);
    if (start === -1) {
      output += value.slice(cursor);
      return output;
    }

    const charsetEnd = value.indexOf("?", start + 2);
    if (charsetEnd === -1) {
      output += value.slice(cursor);
      return output;
    }
    const charset = value.slice(start + 2, charsetEnd);

    const encodingEnd = charsetEnd + 2;
    if (encodingEnd >= value.length || value[encodingEnd] !== "?") {
      output += value.slice(cursor, start + 2);
      cursor = start + 2;
      previousWasEncoded = false;
      continue;
    }
    const encoding = value[charsetEnd + 1] ?? "";

    const textEnd = value.indexOf("?=", encodingEnd + 1);
    if (textEnd === -1) {
      output += value.slice(cursor);
      return output;
    }
    if (textEnd - start > MAX_ENCODED_WORD) {
      output += value.slice(cursor, start + 2);
      cursor = start + 2;
      previousWasEncoded = false;
      continue;
    }

    const payload = value.slice(encodingEnd + 1, textEnd);
    const end = textEnd + 2;
    const decoded = decodeWord(encoding, payload);
    if (decoded === undefined) {
      // A malformed encoded-word is emitted verbatim and does not participate
      // in adjacent-word whitespace collapsing.
      output += value.slice(cursor, end);
      cursor = end;
      previousWasEncoded = false;
      continue;
    }

    const between = value.slice(cursor, start);
    if (!previousWasEncoded || !isWhitespace(between)) {
      output += between;
    }

    const text = decodeCharset(charset, decoded);
    if (text === undefined) {
      return undefined;
    }
    output += text;

    cursor = end;
    previousWasEncoded = true;
  }
}

/** Reports whether a string consists only of linear whitespace. */
function isWhitespace(value: string): boolean {
  return /^[ \t]*$/.test(value);
}

/**
 * Decodes one encoded-word payload.
 *
 * @returns The raw bytes, or `undefined` when the encoding or payload is
 * malformed.
 */
function decodeWord(encoding: string, payload: string): Uint8Array | undefined {
  switch (encoding.toUpperCase()) {
    case "B":
      return decodeBase64(payload);
    case "Q":
      return decodeQ(payload);
    default:
      return undefined;
  }
}

/** Decodes a Base64 payload strictly, rejecting invalid lengths and alphabet. */
function decodeBase64(payload: string): Uint8Array | undefined {
  if (payload === "") {
    return new Uint8Array(0);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    return undefined;
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) {
    return undefined;
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Decodes a `Q` payload: underscores are spaces, `=XX` is a byte. */
function decodeQ(payload: string): Uint8Array | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index] ?? "";
    if (char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=") {
      const hex = payload.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        return undefined;
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    const code = payload.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return undefined;
    }
    bytes.push(code);
  }
  return Uint8Array.from(bytes);
}

/** Interprets decoded bytes using the encoded-word's character set. */
function decodeCharset(charset: string, bytes: Uint8Array): string | undefined {
  const label = charset.toLowerCase();
  if (label === "utf-8") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (label === "us-ascii") {
    let text = "";
    for (const byte of bytes) {
      text += byte < 0x80 ? String.fromCharCode(byte) : "\uFFFD";
    }
    return text;
  }
  // Every other label goes through the WHATWG registry, which maps
  // `iso-8859-1` and its aliases to the windows-1252 superset. That is what
  // senders mean in practice, and it keeps bytes 0x80-0x9F from arriving as C1
  // controls that no display name may contain.
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return undefined;
  }
}
