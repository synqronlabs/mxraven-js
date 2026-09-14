/**
 * RFC 5322 mailbox parsing and formatting.
 *
 * This module is internal to the SDK. It implements the focused subset needed to parse and format
 * `From`, `Sender`, `Reply-To`, `To`, `Cc`, and `Bcc` addresses, including display names, quoted
 * local parts, and RFC 2047 encoding of non-ASCII display names.
 *
 * @internal
 */

import { Buffer } from "node:buffer";

/** A parsed mailbox address. */
export interface MailboxAddress {
  /** The local part, without quoting. */
  readonly localPart: string;
  /** The domain, or a domain literal such as `[192.0.2.1]`. */
  readonly domain: string;
  /** The display name, when one was supplied. */
  readonly displayName?: string;
}

/** Reports whether a string contains a non-ASCII code unit. */
export function containsNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) >= 0x80) {
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

/**
 * Parses a single mailbox address.
 *
 * Accepts a bare address, an angle-bracketed address, a display name followed by
 * an angle-bracketed address, and a quoted display name.
 *
 * @throws `Error` when the address is empty, contains a line break, or is not a
 * valid mailbox.
 * @internal
 */
export function parseAddress(input: string): MailboxAddress {
  const value = input.trim();
  if (value === "") {
    throw new Error("mail: address is empty");
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`mail: address contains a line break: ${JSON.stringify(input)}`);
  }

  const open = value.indexOf("<");
  if (open !== -1) {
    const close = value.lastIndexOf(">");
    if (close < open) {
      throw new Error(`mail: invalid address: ${JSON.stringify(input)}`);
    }
    const rest = value.slice(close + 1).trim();
    if (rest !== "") {
      throw new Error(`mail: invalid address: ${JSON.stringify(input)}`);
    }
    const displayName = parseDisplayName(value.slice(0, open).trim());
    const { localPart, domain } = parseAddrSpec(value.slice(open + 1, close).trim());
    return displayName === "" ? { localPart, domain } : { localPart, domain, displayName };
  }

  const { localPart, domain } = parseAddrSpec(value);
  return { localPart, domain };
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

/** Removes surrounding quotes and unescapes a quoted display name. */
function parseDisplayName(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return raw;
}

/** Parses an `addr-spec` into its local part and domain. */
function parseAddrSpec(value: string): { localPart: string; domain: string } {
  if (value === "") {
    throw new Error("mail: address is empty");
  }

  if (value.startsWith('"')) {
    const end = findClosingQuote(value);
    if (end === -1) {
      throw new Error(`mail: unterminated quoted local part: ${JSON.stringify(value)}`);
    }
    const localPart = value.slice(1, end).replace(/\\(.)/g, "$1");
    const rest = value.slice(end + 1);
    if (!rest.startsWith("@")) {
      throw new Error(`mail: invalid address: ${JSON.stringify(value)}`);
    }
    const domain = rest.slice(1);
    validateDomain(domain);
    return { localPart, domain };
  }

  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) {
    throw new Error(`mail: invalid address: ${JSON.stringify(value)}`);
  }
  const localPart = value.slice(0, at);
  const domain = value.slice(at + 1);
  validateLocalPart(localPart);
  validateDomain(domain);
  return { localPart, domain };
}

/** Finds the index of the closing quote of a quoted string starting at 0. */
function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === '"') {
      return i;
    }
  }
  return -1;
}

/** Validates an unquoted dot-atom local part, allowing international letters. */
function validateLocalPart(localPart: string): void {
  const atoms = localPart.split(".");
  for (const atom of atoms) {
    if (atom === "") {
      throw new Error(`mail: invalid local part: ${JSON.stringify(localPart)}`);
    }
    for (const char of atom) {
      if (!isAtext(char)) {
        throw new Error(`mail: invalid local part: ${JSON.stringify(localPart)}`);
      }
    }
  }
}

/** Validates a domain, including bracketed domain literals. */
function validateDomain(domain: string): void {
  if (domain === "") {
    throw new Error("mail: address domain is empty");
  }
  if (domain.startsWith("[") && domain.endsWith("]")) {
    return;
  }
  const labels = domain.split(".");
  for (const label of labels) {
    if (label === "") {
      throw new Error(`mail: invalid domain: ${JSON.stringify(domain)}`);
    }
    for (const char of label) {
      if (!isDomainChar(char)) {
        throw new Error(`mail: invalid domain: ${JSON.stringify(domain)}`);
      }
    }
  }
}

/** Reports whether a character is valid in an unquoted `atext` atom. */
function isAtext(char: string): boolean {
  if (char.charCodeAt(0) >= 0x80) {
    return true;
  }
  return /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]/.test(char);
}

/** Reports whether a character is permitted in a domain label. */
function isDomainChar(char: string): boolean {
  if (char.charCodeAt(0) >= 0x80) {
    return true;
  }
  return /[A-Za-z0-9_-]/.test(char);
}
