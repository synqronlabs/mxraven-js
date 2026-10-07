/**
 * Defensive parsing of inbound RFC 5322 / MIME messages.
 *
 * The parser is intentionally lenient: real mail is frequently malformed, with
 * missing blank lines, LF-only line endings, broken boundaries, and unknown
 * charsets. Malformed input yields the best available interpretation rather
 * than an exception. Only input that is structurally unbounded — excessive
 * nesting or an excessive number of parts — is rejected, to keep untrusted
 * messages from exhausting the stack or memory.
 */

import { Buffer } from "node:buffer";

import { mailboxToString, parseAddress } from "../internal/address.js";

/** Maximum MIME nesting depth. */
const MAX_DEPTH = 20;

/** Maximum number of MIME entities in one message. */
const MAX_PARTS = 2000;

/** A header field read from a parsed message. */
export interface ParsedHeader {
  /** The field name, as it appeared in the message. */
  readonly name: string;
  /** The unfolded field value. Encoded words are not decoded. */
  readonly value: string;
}

/** An address from a parsed message. */
export interface ParsedAddress {
  /** The display name, with RFC 2047 encoded words decoded, when one was present. */
  readonly name?: string;
  /** The bare `local@domain` form. */
  readonly address: string;
}

/** An attachment from a parsed message. */
export interface ParsedAttachment {
  /** The filename, decoded when it was encoded. */
  readonly filename?: string;
  /** The media type, for example `application/pdf`. */
  readonly contentType: string;
  /** The `Content-ID` value, without angle brackets, for inline parts. */
  readonly contentId?: string;
  /** Whether the part is marked `inline` or carries a `Content-ID`. */
  readonly inline: boolean;
  /**
   * The decoded attachment bytes. The array is a fresh copy; the caller owns
   * it and may mutate it.
   */
  readonly content: Uint8Array;
}

/** A parsed inbound email message. */
export interface ParsedEmail {
  /**
   * Every header field, in order, with continuation lines unfolded. Values are
   * not decoded; use `subject` or an address field for decoded text.
   */
  readonly headers: readonly ParsedHeader[];
  /** The decoded `Subject`, when the header was present. */
  readonly subject?: string;
  /** The `From` addresses. */
  readonly from: readonly ParsedAddress[];
  /** The `To` addresses. */
  readonly to: readonly ParsedAddress[];
  /** The `Cc` addresses. */
  readonly cc: readonly ParsedAddress[];
  /** The `Bcc` addresses. */
  readonly bcc: readonly ParsedAddress[];
  /** The `Reply-To` addresses. */
  readonly replyTo: readonly ParsedAddress[];
  /** The `Message-ID` without angle brackets, when it was present. */
  readonly messageId?: string;
  /** The `Date`, when it was present and parseable. */
  readonly date?: Date;
  /** The decoded `text/plain` body, when the message has one. */
  readonly text?: string;
  /** The decoded `text/html` body, when the message has one. */
  readonly html?: string;
  /** Every non-body part, with transfer encoding and filename decoding applied. */
  readonly attachments: readonly ParsedAttachment[];
}

/** A header/body split of a message entity. */
interface HeaderSplit {
  /** The offset just before the line terminator that ends the header block. */
  readonly headerEnd: number;
  /** The offset where the body starts. */
  readonly bodyStart: number;
}

/** A parsed header block and its raw body. */
interface Entity {
  /** The parsed header fields. */
  readonly headers: ParsedHeader[];
  /** The undecoded body; a view into the input. */
  readonly body: Uint8Array;
}

/** A parsed `Content-Type` or `Content-Disposition` value. */
interface MediaType {
  /** The lowercase primary type, for example `text`. */
  readonly type: string;
  /** The lowercase subtype, for example `plain`; empty when absent. */
  readonly subtype: string;
  /** The decoded parameters, with RFC 2231 continuation and encoding applied. */
  readonly params: ReadonlyMap<string, string>;
}

/** Mutable state collected while walking a message tree. */
interface WalkState {
  /** The first text body found, if any. */
  text: string | undefined;
  /** The first HTML body found, if any. */
  html: string | undefined;
  /** Every attachment found, in traversal order. */
  readonly attachments: ParsedAttachment[];
  /** How many entities have been visited. */
  partCount: number;
}

/**
 * Parses an inbound RFC 5322 / MIME message.
 *
 * The parser never validates the message against the grammar and never throws
 * on malformed content; it extracts what it can. Multipart `mixed`,
 * `alternative`, and `related` structures are traversed, `base64` and
 * `quoted-printable` transfer encodings are decoded, RFC 2047 encoded words in
 * structured headers are decoded, and RFC 2231 parameters are reassembled.
 * `message/rfc822` parts are exposed as attachments rather than parsed
 * recursively.
 *
 * @param data - The raw message bytes.
 * @returns The parsed message. All returned byte arrays are fresh copies.
 * @throws `Error` When the message exceeds the parser's nesting or part limits,
 * which keep untrusted messages from exhausting the stack or memory.
 *
 * @example
 * ```ts
 * const email = parseEmail(await fetchRawEmail(event.inboundEmail.raw_email));
 * console.log(email.subject, email.attachments.length);
 * ```
 *
 * @public
 */
export function parseEmail(data: Uint8Array): ParsedEmail {
  const state: WalkState = { text: undefined, html: undefined, attachments: [], partCount: 0 };
  const root = data.length > 0 ? parseEntity(data) : undefined;
  if (root !== undefined) {
    walkEntity(root, 0, state);
  }
  const headers = root?.headers ?? [];

  return {
    headers,
    subject: decodeOptionalHeader(headers, "subject"),
    from: headerAddressList(headers, "from"),
    to: headerAddressList(headers, "to"),
    cc: headerAddressList(headers, "cc"),
    bcc: headerAddressList(headers, "bcc"),
    replyTo: headerAddressList(headers, "reply-to"),
    messageId: messageId(headers),
    date: dateHeader(headers),
    text: state.text,
    html: state.html,
    attachments: state.attachments,
  };
}

/** Finds where the header block ends and the body begins. */
function findHeaderEnd(data: Uint8Array): HeaderSplit {
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if (byte !== 0x0a && byte !== 0x0d) {
      continue;
    }
    let next = index + 1;
    if (byte === 0x0d && data[next] === 0x0a) {
      next += 1;
    }
    const upcoming = data[next];
    if (upcoming === 0x0d) {
      const extra = data[next + 1] === 0x0a ? 1 : 0;
      return { headerEnd: index, bodyStart: next + 1 + extra };
    }
    if (upcoming === 0x0a) {
      return { headerEnd: index, bodyStart: next + 1 };
    }
  }
  return { headerEnd: data.length, bodyStart: data.length };
}

/** Parses one entity's header block and slices out its body. */
function parseEntity(data: Uint8Array): Entity {
  const split = findHeaderEnd(data);
  return {
    headers: parseHeaders(data.subarray(0, split.headerEnd)),
    body: data.subarray(split.bodyStart),
  };
}

/** Parses and unfolds a header block decoded as Latin-1 so bytes survive. */
function parseHeaders(block: Uint8Array): ParsedHeader[] {
  const text = Buffer.from(block.buffer, block.byteOffset, block.byteLength).toString("latin1");
  const headers: ParsedHeader[] = [];
  let current: ParsedHeader | undefined;

  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === "") {
      continue;
    }
    if ((line.startsWith(" ") || line.startsWith("\t")) && current !== undefined) {
      current = { name: current.name, value: current.value + line };
      headers[headers.length - 1] = current;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      current = undefined;
      continue;
    }
    const name = line.slice(0, colon).trim();
    if (name === "") {
      current = undefined;
      continue;
    }
    current = {
      name,
      value: line
        .slice(colon + 1)
        .replace(/^[ \t]+/, "")
        .replace(/[ \t]+$/, ""),
    };
    headers.push(current);
  }
  return headers;
}

/** Returns the first header value for a name, compared case-insensitively. */
function lookup(headers: readonly ParsedHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (header.name.toLowerCase() === lower) {
      return header.value;
    }
  }
  return undefined;
}

/** Splits a header value into its first token and parameter segments. */
function splitSegments(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ";" && !quoted) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** Parses a `Content-Type` or `Content-Disposition` value. */
function parseMediaType(value: string | undefined): MediaType {
  if (value === undefined || value.trim() === "") {
    return { type: "text", subtype: "plain", params: new Map() };
  }

  const segments = splitSegments(value);
  const main = (segments[0] ?? "").trim().toLowerCase();
  const slash = main.indexOf("/");
  const type = slash > 0 ? main.slice(0, slash) : main;
  const subtype = slash > 0 ? main.slice(slash + 1) : "";

  const plain: [string, string][] = [];
  const continuations = new Map<string, { index: number; encoded: boolean; value: string }[]>();
  const params = new Map<string, string>();

  for (let index = 1; index < segments.length; index += 1) {
    const segment = (segments[index] ?? "").trim();
    const equals = segment.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = segment.slice(0, equals).trim().toLowerCase();
    let parameterValue = segment.slice(equals + 1).trim();
    if (
      parameterValue.startsWith('"') &&
      parameterValue.endsWith('"') &&
      parameterValue.length >= 2
    ) {
      parameterValue = parameterValue.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    plain.push([key, parameterValue]);
  }

  for (const [key, parameterValue] of plain) {
    if (!key.includes("*")) {
      params.set(key, parameterValue);
      continue;
    }
    if (key.endsWith("*") && !key.slice(0, -1).includes("*")) {
      params.set(key.slice(0, -1), decodeExtendedParameter(parameterValue));
      continue;
    }
    const match = /^(.*)\*(\d+)(\*)?$/.exec(key);
    if (match === null) {
      continue;
    }
    const base = match[1] ?? "";
    const pieceIndex = Number(match[2] ?? "0");
    const encoded = match[3] === "*";
    const pieces = continuations.get(base) ?? [];
    if (pieces.length === 0) {
      continuations.set(base, pieces);
    }
    pieces.push({ index: pieceIndex, encoded, value: parameterValue });
  }

  for (const [base, pieces] of continuations) {
    pieces.sort((left, right) => left.index - right.index);
    const bytes: number[] = [];
    let charset = "utf-8";
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece === undefined) {
        continue;
      }
      if (index === 0 && piece.encoded) {
        const firstQuote = piece.value.indexOf("'");
        const secondQuote = firstQuote === -1 ? -1 : piece.value.indexOf("'", firstQuote + 1);
        if (firstQuote > -1 && secondQuote > -1) {
          charset = piece.value.slice(0, firstQuote) || "utf-8";
          bytes.push(...percentDecode(piece.value.slice(secondQuote + 1)));
        } else {
          bytes.push(...percentDecode(piece.value));
        }
        continue;
      }
      if (piece.encoded) {
        bytes.push(...percentDecode(piece.value));
      } else {
        for (const char of piece.value) {
          bytes.push(char.charCodeAt(0) % 256);
        }
      }
    }
    params.set(base, decodeBytes(Uint8Array.from(bytes), charset));
  }

  return { type, subtype, params };
}

/** Decodes a single RFC 2231 extended parameter, for example `UTF-8''%C3%A9`. */
function decodeExtendedParameter(value: string): string {
  const firstQuote = value.indexOf("'");
  const secondQuote = firstQuote === -1 ? -1 : value.indexOf("'", firstQuote + 1);
  if (firstQuote > -1 && secondQuote > -1) {
    const charset = value.slice(0, firstQuote) || "utf-8";
    return decodeBytes(Uint8Array.from(percentDecode(value.slice(secondQuote + 1))), charset);
  }
  return decodeBytes(Uint8Array.from(percentDecode(value)), "utf-8");
}

/** Percent-decodes an RFC 2231 parameter value into bytes. */
function percentDecode(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char === "%" && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0) % 256);
  }
  return bytes;
}

/** Decodes a body or parameter from bytes, falling back to UTF-8 then Latin-1. */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.trim().toLowerCase();
  if (label !== "" && label !== "us-ascii" && label !== "ascii" && label !== "unknown-8bit") {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown charset label; fall through to the heuristic below.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Decodes RFC 2047 encoded words in a header value. */
function decodeEncodedWords(value: string): string {
  const pattern = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;
  const segments: { encoded: boolean; text: string }[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    if (index > lastIndex) {
      segments.push({ encoded: false, text: value.slice(lastIndex, index) });
    }
    const charset = match[1] ?? "utf-8";
    const kind = (match[2] ?? "B").toUpperCase();
    const payload = match[3] ?? "";
    const bytes =
      kind === "B" ? new Uint8Array(Buffer.from(payload, "base64")) : decodeQEncodedWord(payload);
    segments.push({ encoded: true, text: decodeBytes(bytes, charset) });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) {
    segments.push({ encoded: false, text: value.slice(lastIndex) });
  }

  let output = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }
    if (!segment.encoded && /^[ \t]*$/.test(segment.text)) {
      const previous = segments[index - 1];
      const next = segments[index + 1];
      if (previous?.encoded === true && next?.encoded === true) {
        continue;
      }
    }
    output += segment.text;
  }
  return output;
}

/** Decodes the `Q` payload of an RFC 2047 encoded word. */
function decodeQEncodedWord(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=" && index + 2 < value.length) {
      const hex = value.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0) % 256);
  }
  return Uint8Array.from(bytes);
}

/**
 * Decodes header text: raw 8-bit content is treated as UTF-8 when possible,
 * then RFC 2047 encoded words are decoded.
 */
function decodeHeaderText(value: string): string {
  let text = value;
  if (/[\u0080-\u00ff]/.test(value)) {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value.charCodeAt(index) % 256;
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = value;
    }
  }
  return decodeEncodedWords(text);
}

/** Decodes an optional header value, returning `undefined` when absent. */
function decodeOptionalHeader(headers: readonly ParsedHeader[], name: string): string | undefined {
  const value = lookup(headers, name);
  return value === undefined ? undefined : decodeHeaderText(value);
}

/** Reads a `Message-ID`, stripping the surrounding angle brackets. */
function messageId(headers: readonly ParsedHeader[]): string | undefined {
  const value = lookup(headers, "message-id");
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Reads and best-effort parses the `Date` header. */
function dateHeader(headers: readonly ParsedHeader[]): Date | undefined {
  const value = lookup(headers, "date");
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Parses an address header into its mailbox list. */
function headerAddressList(headers: readonly ParsedHeader[], name: string): ParsedAddress[] {
  const value = lookup(headers, name);
  if (value === undefined || value.trim() === "") {
    return [];
  }
  const addresses: ParsedAddress[] = [];
  for (const piece of splitAddressList(value)) {
    const trimmed = piece.trim();
    if (trimmed === "") {
      continue;
    }
    addresses.push(parseOneAddress(trimmed));
  }
  return addresses;
}

/** Splits an address list on top-level commas. */
function splitAddressList(value: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;
  let commentDepth = 0;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted) {
      if (char === "<") {
        angleDepth += 1;
      } else if (char === ">") {
        angleDepth = angleDepth > 0 ? angleDepth - 1 : 0;
      } else if (char === "(") {
        commentDepth += 1;
      } else if (char === ")") {
        commentDepth = commentDepth > 0 ? commentDepth - 1 : 0;
      } else if (char === "," && angleDepth === 0 && commentDepth === 0) {
        pieces.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  pieces.push(current);
  return pieces;
}

/** Parses one mailbox, falling back to the raw text for malformed entries. */
function parseOneAddress(piece: string): ParsedAddress {
  try {
    const mailbox = parseAddress(piece);
    const name =
      mailbox.displayName === undefined || mailbox.displayName === ""
        ? undefined
        : decodeHeaderText(mailbox.displayName);
    return { address: mailboxToString(mailbox), name };
  } catch {
    const match = /<([^<>]*)>\s*$/.exec(piece);
    return { address: (match?.[1] ?? piece).trim() };
  }
}

/** Decodes a transfer encoding. Unknown encodings pass through unchanged. */
function decodeTransferEncoding(bytes: Uint8Array, encoding: string | undefined): Uint8Array {
  switch (encoding?.trim().toLowerCase()) {
    case "base64":
      return decodeBase64(bytes);
    case "quoted-printable":
      return decodeQuotedPrintable(bytes);
    default:
      return bytes;
  }
}

/** Decodes Base64, ignoring whitespace and any other non-alphabet bytes. */
function decodeBase64(bytes: Uint8Array): Uint8Array {
  const ascii = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("latin1")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  return Uint8Array.from(Buffer.from(ascii, "base64"));
}

/** Decodes quoted-printable, including soft line breaks. */
function decodeQuotedPrintable(bytes: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x3d) {
      if (byte !== undefined) {
        output.push(byte);
      }
      continue;
    }
    const next = bytes[index + 1];
    if (next === 0x0d && bytes[index + 2] === 0x0a) {
      index += 2;
      continue;
    }
    if (next === 0x0a) {
      index += 1;
      continue;
    }
    if (next === undefined) {
      break;
    }
    const high = bytes[index + 1];
    const low = bytes[index + 2];
    if (isHexByte(high) && isHexByte(low)) {
      output.push(Number.parseInt(String.fromCharCode(high) + String.fromCharCode(low), 16));
      index += 2;
      continue;
    }
    output.push(byte);
  }
  return Uint8Array.from(output);
}

/** Reports whether a byte is an ASCII hex digit. */
function isHexByte(byte: number | undefined): byte is number {
  return (
    byte !== undefined &&
    ((byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x46) ||
      (byte >= 0x61 && byte <= 0x66))
  );
}

/**
 * Splits a multipart body on its boundary lines.
 *
 * The CRLF that precedes a boundary belongs to the boundary per RFC 2046, so
 * it is stripped from the part it terminates.
 */
function splitMultipart(body: Uint8Array, boundary: string, parts: Uint8Array[]): void {
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  let position = 0;
  let partStart = -1;

  for (;;) {
    const found = view.indexOf(delimiter, position);
    if (found === -1) {
      if (partStart !== -1) {
        parts.push(body.subarray(partStart));
      }
      return;
    }
    if (found !== 0 && view[found - 1] !== 0x0a) {
      position = found + delimiter.length;
      continue;
    }
    if (partStart !== -1) {
      let end = found;
      if (found > 0 && view[found - 1] === 0x0a) {
        end = found - 1;
        if (end > 0 && view[end - 1] === 0x0d) {
          end -= 1;
        }
      }
      parts.push(body.subarray(partStart, end));
    }
    let after = found + delimiter.length;
    while (view[after] === 0x20 || view[after] === 0x09) {
      after += 1;
    }
    if (view[after] === 0x2d && view[after + 1] === 0x2d) {
      return;
    }
    if (view[after] === 0x0d && view[after + 1] === 0x0a) {
      after += 2;
    } else if (view[after] === 0x0a) {
      after += 1;
    } else if (view[after] === undefined) {
      return;
    } else {
      position = found + delimiter.length;
      continue;
    }
    partStart = after;
    position = after;
  }
}

/** Recursively walks a message entity, collecting bodies and attachments. */
function walkEntity(entity: Entity, depth: number, state: WalkState): void {
  if (depth > MAX_DEPTH) {
    throw new Error("mime: message nesting is too deep");
  }
  state.partCount += 1;
  if (state.partCount > MAX_PARTS) {
    throw new Error("mime: too many MIME parts");
  }

  const contentType = parseMediaType(lookup(entity.headers, "content-type"));
  if (contentType.type === "multipart" && contentType.subtype !== "") {
    const boundary = contentType.params.get("boundary");
    if (boundary !== undefined && boundary !== "") {
      const rawParts: Uint8Array[] = [];
      splitMultipart(entity.body, boundary, rawParts);
      for (const rawPart of rawParts) {
        if (rawPart.length === 0) {
          continue;
        }
        walkEntity(parseEntity(rawPart), depth + 1, state);
      }
      return;
    }
  }

  const encoding = lookup(entity.headers, "content-transfer-encoding");
  const disposition = parseMediaType(lookup(entity.headers, "content-disposition"));
  const placement = (disposition.params.get("disposition") ?? disposition.type).toLowerCase();
  const filename = disposition.params.get("filename") ?? contentType.params.get("name");
  const contentIdValue = lookup(entity.headers, "content-id");
  const contentId =
    contentIdValue === undefined ? undefined : contentIdValue.trim().replace(/^<|>$/g, "");
  const hasFilename = filename !== undefined && filename !== "";
  const isAttachment = placement === "attachment" || hasFilename || contentId !== undefined;

  const decoded = decodeTransferEncoding(entity.body, encoding);

  if (!isAttachment && contentType.type === "text" && contentType.subtype === "plain") {
    if (state.text === undefined) {
      state.text = decodeBytes(decoded, contentType.params.get("charset") ?? "");
    }
    return;
  }
  if (!isAttachment && contentType.type === "text" && contentType.subtype === "html") {
    if (state.html === undefined) {
      state.html = decodeBytes(decoded, contentType.params.get("charset") ?? "");
    }
    return;
  }

  const contentTypeName =
    contentType.subtype === "" ? contentType.type : `${contentType.type}/${contentType.subtype}`;
  state.attachments.push({
    filename: hasFilename ? decodeHeaderText(filename) : undefined,
    contentType: contentTypeName,
    contentId,
    inline: placement === "inline" || (placement !== "attachment" && contentId !== undefined),
    content: decoded === entity.body ? entity.body.slice() : Uint8Array.from(decoded),
  });
}
