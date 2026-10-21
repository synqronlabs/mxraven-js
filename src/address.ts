/**
 * RFC 5322 mailbox parsing and formatting.
 *
 * The public surface is {@link parseAddress}, {@link parseAddressList}, and
 * {@link MailboxAddress}. They implement the RFC 5322 mailbox grammar —
 * `addr-spec`, `[display-name] angle-addr`, groups, comments, folding
 * whitespace, quoted strings, quoted local parts, domain literals, and
 * internationalized addresses — and normalize the result into a form that is
 * safe to use both in headers and as an SMTP envelope path.
 *
 * The formatting helpers in this module are internal: the SDK formats the
 * addresses it parses when it builds a message.
 */

import { Buffer } from "node:buffer";

import { AddressError, addressErrorKind, type AddressErrorKind } from "./errors.js";
import { containsNonAscii } from "./internal/ascii.js";
import { normalizeDomain, normalizeDomainLiteral } from "./internal/domain.js";
import { decodeHeaderWords } from "./internal/encoded-word.js";

/** The RFC 5321 limit on the local part, in octets. */
const MAX_LOCAL_PART_OCTETS = 64;

/** The RFC 5321 limit on a complete address, in octets. */
const MAX_ADDRESS_OCTETS = 254;

/** The longest encoded-word RFC 2047 permits, including its delimiters. */
const MAX_ENCODED_WORD = 75;

/** The RFC 2047 delimiters around a Base64 encoded-word body. */
const ENCODED_WORD_OVERHEAD = "=?UTF-8?B??=".length;

/**
 * The largest Base64 payload that keeps an encoded-word within 75 characters.
 *
 * Base64 emits four characters per three bytes, so the 63 characters left after
 * the delimiters carry 45 bytes.
 */
const MAX_ENCODED_WORD_BYTES = Math.floor((MAX_ENCODED_WORD - ENCODED_WORD_OVERHEAD) / 4) * 3;

/** The line and paragraph separators that some parsers treat as line breaks. */
const LINE_SEPARATORS = new Set([0x2028, 0x2029]);

/**
 * A parsed, normalized mailbox address.
 *
 * Instances are plain immutable data: every field is `readonly`, nothing is
 * lazily computed or retained from the input, and a value can be stored,
 * compared, shared across tasks, or serialized without aliasing anything the
 * parser still holds.
 *
 * @public
 */
export interface MailboxAddress {
  /**
   * The local part, without quoting or comments.
   *
   * Quoting is presentation: `"john.doe"@example.com` and
   * `john.doe@example.com` denote the same mailbox (RFC 5321 section 4.1.2),
   * so the delimiters are removed here and re-added only when the value cannot
   * be expressed as a dot-string.
   */
  readonly localPart: string;
  /**
   * The domain, in lowercase ASCII form, or the domain literal including its
   * brackets. Internationalized domains are converted to their Punycode
   * (A-label) form.
   */
  readonly domain: string;
  /**
   * The display name, with RFC 2047 encoded-words decoded, when the address
   * carried one and it is not empty.
   *
   * It never contains a control character or a Unicode line separator.
   */
  readonly displayName?: string;
}

/**
 * The syntactic shape of an `addr-spec`, before validation.
 *
 * Keeping the shape separate from validation lets the parser rewind on a
 * syntax mismatch without swallowing the specific error that a well-formed but
 * invalid address deserves.
 */
interface AddrSpecShape {
  /** The unquoted local part. */
  readonly localPart: string;
  /** The domain text, without brackets for a domain literal. */
  readonly domain: string;
  /** Whether the domain was written as a domain literal. */
  readonly literal: boolean;
}

/**
 * Returns the bare `local@domain` form of an address.
 *
 * @param address - The mailbox to serialize.
 * @returns The RFC 5321 path form, quoted only when the local part requires it.
 *
 * @internal
 */
export function mailboxToString(address: MailboxAddress): string {
  if (address.localPart === "" && address.domain === "") {
    return "";
  }
  const local = needsQuoting(address.localPart) ? quote(address.localPart) : address.localPart;
  return `${local}@${address.domain}`;
}

/**
 * Parses one RFC 5322 mailbox address and normalizes it.
 *
 * This is the parser the SDK itself uses for envelope senders and recipients
 * and for the address headers it builds, so a value that parses here can be put
 * on the wire unchanged. Use it to validate input before handing it to
 * {@link Message} or {@link Client}, or to inspect how an address will be
 * normalized.
 *
 * @remarks
 * Accepted grammar: the `mailbox` productions `addr-spec` and
 * `[display-name] angle-addr`, with comments and folding whitespace anywhere the
 * grammar allows them, including the obsolete forms that permit CFWS around the
 * dots of a local part or domain. Group syntax is not a mailbox; use
 * {@link parseAddressList} for a header that may contain groups.
 *
 * Normalization:
 *
 * - an internationalized domain becomes its Punycode (A-label) form and every
 *   domain is lowercased, so `user@例え.jp` becomes `user@xn--r8jz45g.jp`;
 * - every domain label must be a valid DNS label, so `user@a_b.example` is
 *   rejected;
 * - the local part is stored unquoted, and `"john.doe"@example.com` is therefore
 *   the same mailbox as `john.doe@example.com` (RFC 5321 section 4.1.2);
 * - RFC 2047 encoded-words in the display name are decoded, so `=?UTF-8?B?...?=`
 *   yields readable text.
 *
 * Validation is strict where the address could become an envelope recipient: the
 * RFC 5321 length limits apply (64-octet local part, 255-octet domain, 254-octet
 * address), a domain literal must be a real IPv4, IPv6, or general address
 * literal, and control characters are rejected, including in a decoded display
 * name. A comment is CFWS rather than a display name, so `user@example.com (Bob)`
 * has no display name.
 *
 * @param input - The address text. It must be exactly one mailbox.
 * @returns The parsed mailbox, normalized for use in a header or as an SMTP
 * envelope path. The result is plain immutable data owned by the caller.
 * @throws {@link AddressError} When the input is not a single valid mailbox.
 * {@link AddressError.kind} identifies the reason.
 *
 * @example
 * ```ts
 * import { AddressError, addressErrorKind, parseAddress } from "@mxraven/mail";
 *
 * const mailbox = parseAddress("Acme <Noreply@例え.jp>");
 * mailbox.localPart; // "Noreply"
 * mailbox.domain; // "xn--r8jz45g.jp"
 * mailbox.displayName; // "Acme"
 *
 * try {
 *   parseAddress("user@例え-.jp");
 * } catch (error) {
 *   if (error instanceof AddressError && error.kind === addressErrorKind.invalidDomain) {
 *     // The domain is not a valid DNS name.
 *   }
 * }
 * ```
 *
 * @public
 */
export function parseAddress(input: string): MailboxAddress {
  return new AddressParser(input).parse();
}

/**
 * Parses a comma-separated RFC 5322 address list and expands its groups.
 *
 * Use this for a header value such as `To`, `Cc`, or `Reply-To`, where one field
 * may carry several mailboxes. Every entry is parsed and normalized exactly like
 * {@link parseAddress}, so the same length limits, domain rules, and encoded-word
 * decoding apply.
 *
 * @remarks
 * A group contributes its member mailboxes and its own display name is
 * discarded, because RFC 5322 does not make the group name part of any member.
 * An empty group such as `undisclosed-recipients:;` contributes no addresses,
 * which is how a sender hides a recipient list.
 *
 * The obsolete list grammar permits commas before the first address, which is
 * accepted. Empty elements between addresses and a trailing comma are rejected:
 * they cannot name a recipient, and dropping them silently would hide a broken
 * header. To inspect a header that may be malformed, split it yourself and call
 * {@link parseAddress} per entry.
 *
 * @param input - The address-list text. Empty or whitespace-only input yields an
 * empty array.
 * @returns The mailboxes in source order, with groups expanded. The result is a
 * fresh mutable array of immutable mailboxes owned by the caller.
 * @throws {@link AddressError} When an entry is not a valid mailbox.
 * {@link AddressError.kind} identifies the first failure.
 *
 * @example
 * ```ts
 * import { parseAddressList } from "@mxraven/mail";
 *
 * const mailboxes = parseAddressList(
 *   'Friends: "Doe, John" <j@example.com>, a@例え.jp;',
 * );
 * mailboxes.map((mailbox) => mailbox.domain);
 * // ["example.com", "xn--r8jz45g.jp"]
 * ```
 *
 * @public
 */
export function parseAddressList(input: string): MailboxAddress[] {
  return new AddressParser(input).parseList();
}

/**
 * Formats one address for use in a header field.
 *
 * A display name is RFC 2047-encoded when it contains non-ASCII characters and
 * quoted when it contains RFC 5322 specials, with backslashes and quotes
 * escaped so the value survives a parse/format round trip.
 *
 * @param address - The mailbox to format.
 * @returns The header representation, for example `"Doe, John" <john@x.example>`.
 * @throws {@link AddressError} When the display name contains a control
 * character that would break the header.
 *
 * @internal
 */
export function formatAddress(address: MailboxAddress): string {
  const email = mailboxToString(address);
  const name = address.displayName;
  if (name === undefined || name === "") {
    return email;
  }
  if (containsForbiddenDisplayChar(name)) {
    throw new AddressError({
      kind: addressErrorKind.invalidHeaderValue,
      message: `mail: display name contains a control character: ${JSON.stringify(name)}`,
    });
  }
  if (containsNonAscii(name)) {
    return `${encodeRfc2047(name)} <${email}>`;
  }
  if (needsDisplayNameQuoting(name)) {
    return `"${escapeQuoted(name)}" <${email}>`;
  }
  return `${name} <${email}>`;
}

/**
 * Formats several addresses as a comma-separated header value.
 *
 * @param addresses - The mailboxes to format.
 * @returns The comma-separated header value.
 *
 * @internal
 */
export function formatAddressList(addresses: readonly MailboxAddress[]): string {
  return addresses.map(formatAddress).join(", ");
}

/**
 * Encodes a string as one or more RFC 2047 Base64 encoded-words.
 *
 * Long values are split across several encoded-words so that no word exceeds
 * the 75-character limit from RFC 2047 section 2. Multi-byte characters are
 * never split between words.
 *
 * @param value - The text to encode.
 * @returns Space-separated encoded-words, for example `=?UTF-8?B?SsO2aG4=?=`.
 *
 * @internal
 */
export function encodeRfc2047(value: string): string {
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (chunkBytes + size > MAX_ENCODED_WORD_BYTES && chunk !== "") {
      words.push(encodeWord(chunk));
      chunk = "";
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += size;
  }
  if (chunk !== "") {
    words.push(encodeWord(chunk));
  }
  return words.join(" ");
}

/** Encodes one chunk as a single RFC 2047 encoded-word. */
function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Reports whether a display name must be quoted when it appears in a header.
 *
 * Besides the RFC 5322 specials, whitespace at either end or repeated inside the
 * name forces quoting: an unquoted phrase collapses runs of whitespace, so the
 * name would not survive a parse/format round trip otherwise.
 */
function needsDisplayNameQuoting(name: string): boolean {
  return /["(),.:;<>@[\\\]]/.test(name) || /^[ \t]|[ \t]$|[ \t]{2}/.test(name);
}

/** Escapes a quoted-string body. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Reports whether a local part must be quoted when serialized.
 *
 * A value is expressible as an RFC 5321 dot-string only when every
 * dot-separated segment is a non-empty run of `atext`; anything else needs a
 * quoted-string.
 */
function needsQuoting(localPart: string): boolean {
  if (localPart === "") {
    return true;
  }
  if (containsNonAscii(localPart)) {
    return false;
  }
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    return true;
  }
  return /[^A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]/.test(localPart);
}

/** Wraps a local part in a quoted string. */
function quote(value: string): string {
  return `"${escapeQuoted(value)}"`;
}

/** Reports whether a code point is an RFC 5322 `atext` character. */
function isAtext(char: string): boolean {
  const code = char.charCodeAt(0);
  if (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39)
  ) {
    return true;
  }
  switch (char) {
    case "!":
    case "#":
    case "$":
    case "%":
    case "&":
    case "'":
    case "*":
    case "+":
    case "-":
    case "/":
    case "=":
    case "?":
    case "^":
    case "_":
    case "`":
    case "{":
    case "|":
    case "}":
    case "~":
      return true;
    default:
      return false;
  }
}

/**
 * Reports whether a value contains a character that may not appear in a display
 * name: a control character, or a Unicode line separator.
 *
 * This is the guard that keeps a decoded RFC 2047 display name from injecting a
 * header or envelope line break.
 */
function containsForbiddenDisplayChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
    if (LINE_SEPARATORS.has(code)) {
      return true;
    }
  }
  return false;
}

/** Reports whether a code point is a control character rejected in comments. */
function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code < 0x20 && char !== "\t") || code === 0x7f;
}

/** Builds an {@link AddressError} with a stable kind. */
function addressError(kind: AddressErrorKind, message: string): AddressError {
  return new AddressError({ kind, message: `mail: ${message}` });
}

/** A recursive-descent parser for one RFC 5322 mailbox. */
class AddressParser {
  private readonly chars: string[];
  private readonly source: string;
  private pos = 0;

  constructor(source: string) {
    this.source = source;
    this.chars = [...source];
  }

  parse(): MailboxAddress {
    const mailboxes = this.parseEntity({ groups: false });
    this.skipCfws();
    this.requireEnd();
    const mailbox = mailboxes[0];
    if (mailbox === undefined) {
      this.fail(addressErrorKind.invalidAddress, `invalid address ${JSON.stringify(this.source)}`);
    }
    return mailbox;
  }

  /**
   * Parses a comma-separated address list, expanding groups.
   *
   * The obsolete list grammar permits empty elements and a trailing comma, and
   * an empty group (`undisclosed-recipients:;`) contributes no addresses.
   */
  parseList(): MailboxAddress[] {
    this.skipCfws();
    // obs-addr-list permits commas before the first address.
    let sawSeparator = false;
    while (this.peek() === ",") {
      sawSeparator = true;
      this.pos += 1;
      this.skipCfws();
    }
    if (this.atEnd()) {
      if (sawSeparator) {
        this.fail(addressErrorKind.invalidAddress, "address list has no address");
      }
      return [];
    }

    const mailboxes: MailboxAddress[] = [];
    for (;;) {
      mailboxes.push(...this.parseEntity({ groups: true }));
      this.skipCfws();
      if (this.atEnd()) {
        return mailboxes;
      }
      if (this.peek() !== ",") {
        this.fail(
          addressErrorKind.invalidAddress,
          `expected a comma in the address list ${JSON.stringify(this.source)}`,
        );
      }
      this.pos += 1;
      this.skipCfws();
      // An empty element can neither be a recipient nor be silently dropped.
      if (this.atEnd() || this.peek() === ",") {
        this.fail(addressErrorKind.invalidAddress, "empty element in the address list");
      }
    }
  }

  /** Parses one mailbox, or one group when `groups` is enabled. */
  private parseEntity(options: { groups: boolean }): MailboxAddress[] {
    const start = this.pos;

    this.skipCfws();
    if (this.peek() === "<") {
      return [this.parseAngleAddr()];
    }

    this.pos = start;
    this.skipCfws();
    if (this.peek() === "@") {
      this.fail(addressErrorKind.localPartEmpty, "local-part is empty");
    }
    const shape = this.tryAddrSpec();
    if (shape !== undefined) {
      // A trailing comment is CFWS, not a display name (RFC 5322 section 3.2.2),
      // so it is skipped rather than promoted into the mailbox model.
      this.skipCfws();
      if (this.atEnd() || this.atEntryEnd()) {
        return [toMailbox(shape)];
      }
    }

    this.pos = start;
    this.skipCfws();
    const phrase = this.parsePhrase();
    this.skipCfws();
    if (this.peek() === ":") {
      if (!options.groups) {
        this.fail(addressErrorKind.invalidAddress, "a group is not a single mailbox");
      }
      return this.parseGroup();
    }
    if (this.peek() !== "<") {
      this.fail(addressErrorKind.invalidAddress, `invalid address ${JSON.stringify(this.source)}`);
    }
    const mailbox = this.parseAngleAddr();
    const displayName = this.finalizeDisplayName(phrase);
    return [displayName === undefined ? mailbox : { ...mailbox, displayName }];
  }

  /**
   * Parses a group body after its colon and returns its members.
   *
   * The group display name is discarded: RFC 5322 does not make it part of any
   * member's display name, and a caller that wants it can read the raw header.
   */
  private parseGroup(): MailboxAddress[] {
    this.pos += 1;
    this.skipCfws();
    // obs-group-list is a run of commas standing in for an empty group-list.
    let commas = 0;
    while (this.peek() === ",") {
      commas += 1;
      this.pos += 1;
      this.skipCfws();
    }
    if (this.peek() === ";") {
      this.pos += 1;
      return [];
    }
    if (commas > 0) {
      this.fail(addressErrorKind.invalidAddress, "a group cannot start with a comma");
    }

    const members: MailboxAddress[] = [];
    for (;;) {
      members.push(...this.parseEntity({ groups: false }));
      this.skipCfws();
      const char = this.peek();
      if (char === ";") {
        this.pos += 1;
        return members;
      }
      if (char !== ",") {
        this.fail(
          addressErrorKind.invalidAddress,
          `expected a comma or semicolon in the group ${JSON.stringify(this.source)}`,
        );
      }
      this.pos += 1;
      this.skipCfws();
      if (this.atEnd() || this.peek() === "," || this.peek() === ";") {
        this.fail(addressErrorKind.invalidAddress, "empty element in the group");
      }
    }
  }

  /** Reports whether the current character ends a list entry. */
  private atEntryEnd(): boolean {
    const char = this.peek();
    return char === "," || char === ";";
  }

  /**
   * Attempts to parse the shape of a bare `addr-spec`, rewinding on mismatch.
   *
   * Only the two failures that mean "this is not an addr-spec after all" — a
   * phrase that turns out to be a display name, or a local part that is not
   * atom syntax — are absorbed. Every other failure is a real diagnosis and is
   * propagated so callers see a specific kind instead of a generic one.
   */
  private tryAddrSpec(): AddrSpecShape | undefined {
    const save = this.pos;
    try {
      return this.parseAddrSpecShape();
    } catch (error) {
      if (
        error instanceof AddressError &&
        (error.kind === addressErrorKind.missingAt ||
          error.kind === addressErrorKind.invalidLocalPart)
      ) {
        this.pos = save;
        return undefined;
      }
      throw error;
    }
  }

  private parseAddrSpecShape(): AddrSpecShape {
    const localPart = this.parseLocalPart();
    this.skipCfws();
    this.expect("@", addressErrorKind.missingAt);
    this.skipCfws();
    return { localPart, ...this.parseDomain() };
  }

  /**
   * Parses `local-part` with the obsolete form that permits CFWS around dots.
   *
   * Comments are discarded and dots are kept, so `user (c) . name` and
   * `user.name` produce the same value.
   */
  private parseLocalPart(): string {
    const segments: string[] = [];
    for (;;) {
      const char = this.peek();
      if (char === undefined || char === "@" || char === "<" || char === ">" || char === ",") {
        this.fail(addressErrorKind.invalidLocalPart, "invalid local-part syntax");
      }
      segments.push(char === '"' ? this.parseQuotedString() : this.parseAtom());

      const save = this.pos;
      this.skipCfws();
      if (this.peek() !== ".") {
        this.pos = save;
        return segments.join(".");
      }
      this.pos += 1;
      this.skipCfws();
    }
  }

  /** Parses the domain part, returning its text and whether it is a literal. */
  private parseDomain(): { domain: string; literal: boolean } {
    if (this.peek() === "[") {
      return { domain: this.parseDomainLiteral(), literal: true };
    }

    const labels: string[] = [];
    for (;;) {
      if (!this.canStartAtom()) {
        const char = this.peek();
        const isEmpty = char === undefined || char === ">" || char === ",";
        this.fail(
          isEmpty ? addressErrorKind.domainEmpty : addressErrorKind.invalidDomain,
          isEmpty ? "domain is empty" : "invalid domain syntax",
        );
      }
      labels.push(this.parseAtom());
      const save = this.pos;
      this.skipCfws();
      if (this.peek() !== ".") {
        this.pos = save;
        return { domain: labels.join("."), literal: false };
      }
      this.pos += 1;
      this.skipCfws();
    }
  }

  private parseAngleAddr(): MailboxAddress {
    this.skipCfws();
    this.expect("<", addressErrorKind.invalidAddress);
    this.skipCfws();
    const shape = this.parseAddrSpecShape();
    this.skipCfws();
    this.expect(">", addressErrorKind.invalidAddress);
    return toMailbox(shape);
  }

  /**
   * Parses a phrase and reconstructs the display name text.
   *
   * Whitespace and comments between words collapse to a single space, quoted
   * strings contribute their unescaped content, and obsolete dots are kept in
   * place. Encoded-words are decoded later, after the whole phrase is known, so
   * adjacent words can be joined correctly.
   */
  private parsePhrase(): string {
    let output = "";
    let pendingSpace = false;
    for (;;) {
      if (this.skipCfws()) {
        pendingSpace = true;
      }
      const char = this.peek();
      if (char === undefined || char === "<" || char === ":" || char === "@" || char === ",") {
        break;
      }
      let text: string;
      if (char === ".") {
        if (output === "") {
          // The obsolete phrase grammar requires a word before the first dot.
          this.fail(addressErrorKind.invalidAddress, "phrase starts with a dot");
        }
        this.pos += 1;
        text = ".";
      } else if (char === '"') {
        text = this.parseQuotedString();
      } else {
        text = this.parseAtom();
      }
      if (pendingSpace && output !== "") {
        output += " ";
      }
      output += text;
      pendingSpace = false;
    }
    return output;
  }

  /** Reports whether the current code point can start an atom. */
  private canStartAtom(): boolean {
    const char = this.peek();
    if (char === undefined) {
      return false;
    }
    return isAtext(char) || (char.codePointAt(0) ?? 0) >= 0x80;
  }

  private parseAtom(): string {
    const start = this.pos;
    while (this.canStartAtom()) {
      this.pos += 1;
    }
    if (this.pos === start) {
      this.fail(
        addressErrorKind.invalidLocalPart,
        `expected an atom in ${JSON.stringify(this.source)}`,
      );
    }
    return this.chars.slice(start, this.pos).join("");
  }

  private parseQuotedString(): string {
    this.expect('"', addressErrorKind.invalidLocalPart);
    let value = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        this.fail(
          addressErrorKind.invalidHeaderValue,
          `unterminated quoted string in ${JSON.stringify(this.source)}`,
        );
      }
      if (char === '"') {
        this.pos += 1;
        return value;
      }
      if (char === "\\") {
        this.pos += 1;
        const escaped = this.peek();
        if (escaped === undefined) {
          this.fail(addressErrorKind.invalidHeaderValue, "unterminated quoted-pair");
        }
        if (escaped === "\r" || escaped === "\n") {
          this.fail(addressErrorKind.invalidLineEnding, "quoted-pair contains a line break");
        }
        value += escaped;
        this.pos += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        value += this.consumeFoldedWhitespace();
        continue;
      }
      if (isControlChar(char)) {
        this.fail(
          addressErrorKind.invalidHeaderValue,
          `invalid character in quoted string ${JSON.stringify(this.source)}`,
        );
      }
      value += char;
      this.pos += 1;
    }
  }

  /** Parses a domain literal and returns the dtext without its brackets. */
  private parseDomainLiteral(): string {
    this.expect("[", addressErrorKind.invalidDomainLiteral);
    let value = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        this.fail(
          addressErrorKind.invalidDomainLiteral,
          `unterminated domain literal in ${JSON.stringify(this.source)}`,
        );
      }
      if (char === "]") {
        this.pos += 1;
        return value;
      }
      if (char === "\\") {
        this.pos += 1;
        const escaped = this.peek();
        if (escaped === undefined) {
          this.fail(addressErrorKind.invalidDomainLiteral, "unterminated quoted-pair");
        }
        if (escaped === "\r" || escaped === "\n") {
          this.fail(
            addressErrorKind.invalidDomainLiteral,
            "quoted-pair in domain literal contains a line break",
          );
        }
        value += escaped;
        this.pos += 1;
        continue;
      }
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        this.skipFws();
        continue;
      }
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x21 || code > 0x7e || char === "[") {
        this.fail(
          addressErrorKind.invalidDomainLiteral,
          `invalid character in domain literal ${JSON.stringify(this.source)}`,
        );
      }
      value += char;
      this.pos += 1;
    }
  }

  private consumeComment(): string {
    this.expect("(", addressErrorKind.invalidHeaderValue);
    let depth = 1;
    let text = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        this.fail(
          addressErrorKind.invalidHeaderValue,
          `unterminated comment in ${JSON.stringify(this.source)}`,
        );
      }
      if (char === "(") {
        depth += 1;
        this.pos += 1;
        text = appendWordSeparator(text);
        continue;
      }
      if (char === ")") {
        depth -= 1;
        this.pos += 1;
        if (depth === 0) {
          return text.trim();
        }
        text = appendWordSeparator(text);
        continue;
      }
      if (char === "\\") {
        this.pos += 1;
        const escaped = this.peek();
        if (escaped === undefined) {
          this.fail(addressErrorKind.invalidHeaderValue, "unterminated quoted-pair in comment");
        }
        if (escaped === "\r" || escaped === "\n") {
          this.fail(addressErrorKind.invalidLineEnding, "quoted-pair contains a line break");
        }
        text += escaped;
        this.pos += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        text += this.consumeFoldedWhitespace();
        continue;
      }
      if (isControlChar(char)) {
        this.fail(
          addressErrorKind.invalidHeaderValue,
          `invalid character in comment ${JSON.stringify(this.source)}`,
        );
      }
      text += char;
      this.pos += 1;
    }
  }

  /** Skips folding whitespace and comments. Reports whether anything was skipped. */
  private skipCfws(): boolean {
    let skipped = false;
    for (;;) {
      if (this.skipFws()) {
        skipped = true;
      }
      if (this.peek() !== "(") {
        return skipped;
      }
      this.consumeComment();
      skipped = true;
    }
  }

  /** Skips spaces, tabs, and valid folded line breaks. */
  private skipFws(): boolean {
    let skipped = false;
    for (;;) {
      const char = this.peek();
      if (char === " " || char === "\t") {
        this.pos += 1;
        skipped = true;
        continue;
      }
      if (char === "\r" || char === "\n") {
        this.consumeFoldedWhitespace();
        skipped = true;
        continue;
      }
      return skipped;
    }
  }

  /**
   * Consumes one folded line break and returns a single space.
   *
   * RFC 5322 requires CRLF to be followed by whitespace; a bare CR, a bare LF,
   * or a fold without trailing whitespace is rejected.
   */
  private consumeFoldedWhitespace(): string {
    if (this.peek() === "\r") {
      if (this.lookahead(1) !== "\n") {
        this.fail(addressErrorKind.invalidLineEnding, "bare carriage return");
      }
      if (this.lookahead(2) !== " " && this.lookahead(2) !== "\t") {
        this.fail(
          addressErrorKind.invalidLineEnding,
          "folding whitespace must follow a line break",
        );
      }
      this.pos += 3;
    } else {
      this.fail(addressErrorKind.invalidLineEnding, "bare line feed");
    }
    while (this.peek() === " " || this.peek() === "\t") {
      this.pos += 1;
    }
    return " ";
  }

  /**
   * Decodes and validates a display name.
   *
   * @returns The display name, or `undefined` when it is empty.
   */
  private finalizeDisplayName(raw: string): string | undefined {
    if (raw === "") {
      return undefined;
    }
    const decoded = decodeHeaderWords(raw);
    if (decoded === undefined) {
      this.fail(
        addressErrorKind.unsupportedCharset,
        `unsupported character set in display name ${JSON.stringify(raw)}`,
      );
    }
    if (containsForbiddenDisplayChar(decoded)) {
      this.fail(
        addressErrorKind.invalidHeaderValue,
        `display name contains a control character: ${JSON.stringify(decoded)}`,
      );
    }
    return decoded === "" ? undefined : decoded;
  }

  private expect(char: string, kind: AddressErrorKind): void {
    if (this.peek() !== char) {
      this.fail(kind, `expected ${JSON.stringify(char)} in ${JSON.stringify(this.source)}`);
    }
    this.pos += 1;
  }

  private requireEnd(): void {
    if (!this.atEnd()) {
      this.fail(
        addressErrorKind.invalidAddress,
        `unexpected text after address in ${JSON.stringify(this.source)}`,
      );
    }
  }

  private atEnd(): boolean {
    return this.pos >= this.chars.length;
  }

  private peek(): string | undefined {
    return this.chars[this.pos];
  }

  private lookahead(offset: number): string | undefined {
    return this.chars[this.pos + offset];
  }

  private fail(kind: AddressErrorKind, message: string): never {
    throw addressError(kind, message);
  }
}

/** Validates a parsed shape and builds the normalized mailbox. */
function toMailbox(shape: AddrSpecShape): MailboxAddress {
  assertWellFormed(shape.localPart);
  assertWellFormed(shape.domain);
  const domain = shape.literal
    ? normalizeDomainLiteral(shape.domain)
    : normalizeDomain(shape.domain);
  return makeMailbox(shape.localPart, domain);
}

/** Validates the length limits of a mailbox whose domain is already normalized. */
function makeMailbox(localPart: string, domain: string): MailboxAddress {
  assertPathSafe(localPart);

  const local = needsQuoting(localPart) ? quote(localPart) : localPart;
  const localOctets = Buffer.byteLength(local, "utf8");
  if (localOctets > MAX_LOCAL_PART_OCTETS) {
    throw addressError(
      addressErrorKind.localPartTooLong,
      `local-part exceeds ${MAX_LOCAL_PART_OCTETS} octets`,
    );
  }
  if (localOctets + 1 + Buffer.byteLength(domain, "utf8") > MAX_ADDRESS_OCTETS) {
    throw addressError(
      addressErrorKind.addressTooLong,
      `address exceeds ${MAX_ADDRESS_OCTETS} octets`,
    );
  }
  return { localPart, domain };
}

/**
 * Rejects a local part that cannot be placed in an SMTP path.
 *
 * A quoted string may contain tab per RFC 5322, but RFC 5321 `QcontentSMTP`
 * excludes every control character, so such a local part has no valid wire
 * form. Unicode line separators are rejected for the same reason the display
 * name rejects them: consumers treat them as line breaks. Non-ASCII text is
 * otherwise permitted (RFC 6532).
 */
function assertPathSafe(localPart: string): void {
  for (const char of localPart) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isControl || LINE_SEPARATORS.has(code)) {
      throw addressError(
        addressErrorKind.invalidLocalPart,
        "local-part contains a character that cannot appear in an SMTP path",
      );
    }
  }
}

/** Rejects strings that are not well-formed UTF-16 (unpaired surrogates). */
function assertWellFormed(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw addressError(addressErrorKind.invalidUtf8, "address is not valid UTF-8");
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw addressError(addressErrorKind.invalidUtf8, "address is not valid UTF-8");
    }
  }
}

/** Ensures a comment word separator between accumulated fragments. */
function appendWordSeparator(text: string): string {
  return text === "" || text.endsWith(" ") ? text : `${text} `;
}
