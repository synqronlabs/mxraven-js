/**
 * RFC 5322 mailbox parsing and formatting.
 *
 * This module is internal to the SDK. It implements the RFC 5322 mailbox
 * grammar, including comments and folding whitespace (`CFWS`), quoted strings,
 * quoted local parts, domain literals, and internationalized addresses.
 *
 * Group syntax (`display-name: mailbox-list;`) is not supported.
 *
 * @internal
 */

import { Buffer } from "node:buffer";

/** A parsed mailbox address. */
export interface MailboxAddress {
  /** The local part, without quoting. */
  readonly localPart: string;
  /** The domain, including brackets for a domain literal. */
  readonly domain: string;
  /** The display name, when one was supplied. */
  readonly displayName?: string;
}

/** Reports whether a string contains a non-ASCII code unit. */
export function containsNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) >= 0x80) {
      return true;
    }
  }
  return false;
}

/** Returns the bare `local@domain` form of an address. */
export function mailboxToString(address: MailboxAddress): string {
  if (address.localPart === "" && address.domain === "") {
    return "";
  }
  const local = needsQuoting(address.localPart)
    ? `"${address.localPart.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : address.localPart;
  return `${local}@${address.domain}`;
}

/**
 * Parses a single mailbox address.
 *
 * Accepts the RFC 5322 `mailbox` productions — `addr-spec`,
 * `[display-name] angle-addr` — with comments and folding whitespace anywhere
 * the grammar permits them. Comments are discarded except for a trailing
 * comment after a bare `addr-spec`, which is used as the display name.
 *
 * @param input - The address text.
 * @returns The parsed mailbox.
 * @throws `Error` When the input contains a line break, is empty, or is not a
 * valid mailbox.
 *
 * @internal
 */
export function parseAddress(input: string): MailboxAddress {
  return new AddressParser(input).parse();
}

/** Formats one address for use in a header field. */
export function formatAddress(address: MailboxAddress): string {
  const email = mailboxToString(address);
  const name = address.displayName;
  if (name === undefined || name === "") {
    return email;
  }
  if (containsNonAscii(name)) {
    return `${encodeRfc2047(name)} <${email}>`;
  }
  if (/[!"(),.:;<>@[\\\]]/.test(name)) {
    const quoted = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${quoted}" <${email}>`;
  }
  return `${name} <${email}>`;
}

/** Formats several addresses as a comma-separated header value. */
export function formatAddressList(addresses: readonly MailboxAddress[]): string {
  return addresses.map(formatAddress).join(", ");
}

/** Encodes a string using RFC 2047 Base64 (`=?UTF-8?B?...?=`). */
export function encodeRfc2047(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Reports whether a local part must be quoted when serialized. */
function needsQuoting(localPart: string): boolean {
  if (containsNonAscii(localPart)) {
    return false;
  }
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    return true;
  }
  return /[^A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]/.test(localPart);
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

/** Joins phrase words, attaching stray dots without a preceding space. */
function joinPhrase(words: readonly string[]): string {
  let result = "";
  for (const word of words) {
    if (word === ".") {
      result += ".";
    } else if (result === "") {
      result = word;
    } else {
      result += ` ${word}`;
    }
  }
  return result;
}

/** A recursive-descent parser for one RFC 5322 mailbox. */
class AddressParser {
  private readonly source: string;
  private readonly chars: string[];
  private pos = 0;

  constructor(source: string) {
    this.source = source;
    this.chars = [...source];
  }

  parse(): MailboxAddress {
    const start = this.pos;

    this.skipCfws();
    if (this.peek() === "<") {
      const angle = this.parseAngleAddr();
      this.skipCfws();
      this.requireEnd();
      return angle;
    }

    this.pos = start;
    this.skipCfws();
    const spec = this.tryAddrSpec();
    if (spec !== undefined) {
      const name = this.consumeTrailingComment();
      if (this.atEnd()) {
        return name === undefined
          ? spec
          : { localPart: spec.localPart, domain: spec.domain, displayName: name };
      }
    }

    this.pos = start;
    this.skipCfws();
    const displayName = this.parsePhrase();
    this.skipCfws();
    if (this.peek() !== "<") {
      this.fail(`invalid address ${JSON.stringify(this.source)}`);
    }
    const angle = this.parseAngleAddr();
    this.skipCfws();
    this.requireEnd();
    return displayName === ""
      ? angle
      : { localPart: angle.localPart, domain: angle.domain, displayName };
  }

  private tryAddrSpec(): MailboxAddress | undefined {
    const save = this.pos;
    try {
      return this.parseAddrSpec();
    } catch {
      this.pos = save;
      return undefined;
    }
  }

  private parseAddrSpec(): MailboxAddress {
    const localPart = this.parseLocalPart();
    this.skipCfws();
    this.expect("@");
    this.skipCfws();
    const domain = this.parseDomain();
    return { localPart, domain };
  }

  private parseLocalPart(): string {
    if (this.peek() === '"') {
      return this.parseQuotedString();
    }
    return this.parseDotAtomText(true);
  }

  private parseDomain(): string {
    if (this.peek() === "[") {
      return this.parseDomainLiteral();
    }
    return this.parseDotAtomText(true);
  }

  private parseAngleAddr(): MailboxAddress {
    this.skipCfws();
    this.expect("<");
    this.skipCfws();
    const spec = this.parseAddrSpec();
    this.skipCfws();
    this.expect(">");
    return spec;
  }

  private parsePhrase(): string {
    const words: string[] = [];
    for (;;) {
      this.skipCfws();
      const char = this.peek();
      if (char === undefined || char === "<" || char === ":" || char === "@" || char === ",") {
        break;
      }
      if (char === ".") {
        words.push(".");
        this.pos += 1;
        continue;
      }
      if (char === '"') {
        words.push(this.parseQuotedString());
        continue;
      }
      words.push(this.parseAtom(true));
    }
    return joinPhrase(words);
  }

  private parseAtom(allowUtf8: boolean): string {
    const start = this.pos;
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        break;
      }
      if (isAtext(char) || (allowUtf8 && (char.codePointAt(0) ?? 0) >= 0x80)) {
        this.pos += 1;
        continue;
      }
      break;
    }
    if (this.pos === start) {
      this.fail(`expected an atom in ${JSON.stringify(this.source)}`);
    }
    return this.chars.slice(start, this.pos).join("");
  }

  private parseDotAtomText(allowUtf8: boolean): string {
    let value = this.parseAtom(allowUtf8);
    while (this.peek() === ".") {
      this.pos += 1;
      value += `.${this.parseAtom(allowUtf8)}`;
    }
    return value;
  }

  private parseQuotedString(): string {
    this.expect('"');
    let value = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        this.fail(`unterminated quoted string in ${JSON.stringify(this.source)}`);
      }
      if (char === '"') {
        this.pos += 1;
        return value;
      }
      if (char === "\\") {
        this.pos += 1;
        const escaped = this.peek();
        if (escaped === undefined || escaped === "\r" || escaped === "\n" || escaped === "\u0000") {
          this.fail(`invalid quoted pair in ${JSON.stringify(this.source)}`);
        }
        value += escaped;
        this.pos += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        value += this.consumeFoldedWhitespace();
        continue;
      }
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 && char !== "\t") {
        this.fail(`invalid character in quoted string ${JSON.stringify(this.source)}`);
      }
      value += char;
      this.pos += 1;
    }
  }

  private parseDomainLiteral(): string {
    this.expect("[");
    let value = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        this.fail(`unterminated domain literal in ${JSON.stringify(this.source)}`);
      }
      if (char === "]") {
        this.pos += 1;
        return `[${value}]`;
      }
      if (char === "\\") {
        this.pos += 1;
        const escaped = this.peek();
        if (escaped === undefined || escaped === "\r" || escaped === "\n") {
          this.fail(`invalid quoted pair in domain literal`);
        }
        value += escaped;
        this.pos += 1;
        continue;
      }
      const code = char.codePointAt(0) ?? 0;
      if (code < 33 || code > 126 || char === "[") {
        this.fail(`invalid character in domain literal ${JSON.stringify(this.source)}`);
      }
      value += char;
      this.pos += 1;
    }
  }

  private consumeTrailingComment(): string | undefined {
    let name: string | undefined;
    for (;;) {
      this.skipFws();
      if (this.peek() !== "(") {
        break;
      }
      const text = this.consumeComment();
      if (name === undefined && text !== "") {
        name = text;
      }
    }
    return name;
  }

  private consumeComment(): string {
    this.expect("(");
    let depth = 1;
    let text = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        this.fail(`unterminated comment in ${JSON.stringify(this.source)}`);
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
        if (escaped === undefined || escaped === "\r" || escaped === "\n" || escaped === "\u0000") {
          this.fail(`invalid quoted pair in comment`);
        }
        text += escaped;
        this.pos += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        text += this.consumeFoldedWhitespace();
        continue;
      }
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 && char !== "\t") {
        this.fail(`invalid character in comment ${JSON.stringify(this.source)}`);
      }
      text += char;
      this.pos += 1;
    }
  }

  private skipCfws(): void {
    for (;;) {
      this.skipFws();
      if (this.peek() === "(") {
        this.consumeComment();
        continue;
      }
      break;
    }
  }

  private skipFws(): void {
    for (;;) {
      const char = this.peek();
      if (char === " " || char === "\t") {
        this.pos += 1;
        continue;
      }
      if (char === "\r" || char === "\n") {
        this.consumeFoldedWhitespace();
        continue;
      }
      break;
    }
  }

  private consumeFoldedWhitespace(): string {
    if (this.peek() === "\r") {
      if (this.lookahead(1) !== "\n") {
        this.fail("bare carriage return");
      }
      if (this.lookahead(2) !== " " && this.lookahead(2) !== "\t") {
        this.fail("folding without trailing whitespace");
      }
      this.pos += 3;
    } else {
      this.fail("bare line feed");
    }
    while (this.peek() === " " || this.peek() === "\t") {
      this.pos += 1;
    }
    return " ";
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      this.fail(`expected ${JSON.stringify(char)} in ${JSON.stringify(this.source)}`);
    }
    this.pos += 1;
  }

  private requireEnd(): void {
    if (!this.atEnd()) {
      this.fail(`unexpected text after address in ${JSON.stringify(this.source)}`);
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

  private fail(message: string): never {
    throw new Error(`mail: ${message}`);
  }
}

/** Ensures a comment word separator between accumulated fragments. */
function appendWordSeparator(text: string): string {
  return text === "" || text.endsWith(" ") ? text : `${text} `;
}
