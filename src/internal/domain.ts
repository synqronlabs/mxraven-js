/**
 * Domain name validation and normalization.
 *
 * This module is internal to the SDK. It turns the domain text produced by the
 * mailbox parser into the value that will be published: an ASCII, lowercased
 * DNS name, or a validated address literal.
 *
 * @internal
 */

import { Buffer } from "node:buffer";

import { AddressError, addressErrorKind, type AddressErrorKind } from "../errors.js";
import { containsNonAscii } from "./ascii.js";
import { toAsciiDomain } from "./idna.js";

/** The RFC 5321 limit on the domain, in octets. */
const MAX_DOMAIN_OCTETS = 255;

/** The RFC 5321 limit on a single DNS label, in octets. */
const MAX_LABEL_OCTETS = 63;

/** An RFC 5321 `sub-domain`: an LDH label that starts and ends alphanumerically. */
const LDH_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** Builds an {@link AddressError} with a stable kind. */
function addressError(kind: AddressErrorKind, message: string): AddressError {
  return new AddressError({ kind, message: `mail: ${message}` });
}

/**
 * Normalizes a dot-atom domain.
 *
 * Internationalized domains are converted to their Punycode form, and the
 * result is lowercased. Every label must then satisfy the RFC 5321 `sub-domain`
 * (LDH) rules, so a syntactically odd header domain cannot be emitted as a
 * recipient domain. Punycode output is ASCII, so the octet limits apply
 * directly.
 *
 * @param domain - The dot-atom domain text, without a domain literal's brackets.
 * @returns The normalized ASCII domain.
 * @throws {@link AddressError} When the domain is empty, is not a valid
 * internationalized domain, or exceeds the RFC 5321 length limits.
 *
 * @internal
 */
export function normalizeDomain(domain: string): string {
  if (domain === "") {
    throw addressError(addressErrorKind.domainEmpty, "domain is empty");
  }

  let ascii = domain;
  if (containsNonAscii(domain)) {
    const converted = toAsciiDomain(domain);
    if (converted === undefined) {
      throw addressError(
        addressErrorKind.invalidDomain,
        `invalid internationalized domain ${JSON.stringify(domain)}`,
      );
    }
    ascii = converted;
  } else {
    ascii = ascii.toLowerCase();
  }

  if (ascii.startsWith(".") || ascii.endsWith(".") || ascii.includes("..")) {
    throw addressError(addressErrorKind.invalidDomain, "invalid domain syntax");
  }
  for (const label of ascii.split(".")) {
    if (Buffer.byteLength(label, "utf8") > MAX_LABEL_OCTETS) {
      throw addressError(addressErrorKind.invalidDomain, "domain label exceeds 63 octets");
    }
    // RFC 5321 section 4.1.2: a sub-domain is an LDH label, so odd header
    // dot-atoms (`a_b.example`, `-x.example`) cannot become a recipient domain.
    if (!LDH_LABEL.test(label)) {
      throw addressError(addressErrorKind.invalidDomain, "invalid domain syntax");
    }
  }
  if (Buffer.byteLength(ascii, "utf8") > MAX_DOMAIN_OCTETS) {
    throw addressError(
      addressErrorKind.domainTooLong,
      `domain exceeds ${MAX_DOMAIN_OCTETS} octets`,
    );
  }
  return ascii;
}

/**
 * Validates a domain literal and returns it with its brackets.
 *
 * The literal must be an IPv4 address, an `IPv6:` address, or a general
 * address literal with a standardized tag.
 *
 * @param content - The `dtext` between the brackets, with quoted-pairs resolved.
 * @returns The literal including its brackets.
 * @throws {@link AddressError} When the literal is empty or not a valid address
 * literal.
 *
 * @internal
 */
export function normalizeDomainLiteral(content: string): string {
  if (content === "") {
    throw addressError(addressErrorKind.invalidDomainLiteral, "domain literal is empty");
  }
  if (content.toLowerCase().startsWith("ipv6:")) {
    if (!isValidIPv6(content.slice(5))) {
      throw addressError(
        addressErrorKind.invalidDomainLiteral,
        `invalid IPv6 address literal ${JSON.stringify(content)}`,
      );
    }
    return `[${content}]`;
  }
  if (isValidIPv4(content)) {
    return `[${content}]`;
  }

  const colon = content.indexOf(":");
  if (colon > 0 && isValidStandardizedTag(content.slice(0, colon))) {
    if (/^[\x21-\x5a\x5e-\x7e]+$/.test(content.slice(colon + 1))) {
      return `[${content}]`;
    }
  }
  throw addressError(
    addressErrorKind.invalidDomainLiteral,
    `invalid address literal ${JSON.stringify(content)}`,
  );
}

/** Validates an IPv4 address literal. */
function isValidIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (part === "" || part.length > 3 || !/^[0-9]+$/.test(part)) {
      return false;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }
    if (Number(part) > 255) {
      return false;
    }
  }
  return true;
}

/** Validates an IPv6 address literal, including IPv4-embedded forms. */
function isValidIPv6(value: string): boolean {
  let text = value;
  if (text === "") {
    return false;
  }

  const dot = text.lastIndexOf(".");
  if (dot !== -1) {
    const colon = text.lastIndexOf(":");
    if (colon > dot || !isValidIPv4(text.slice(colon + 1))) {
      return false;
    }
    text = text.slice(0, colon + 1);
  }

  const colons = text.split(":").length - 1;
  if (text.includes("::")) {
    if (text.split("::").length > 2 || colons > 7) {
      return false;
    }
  } else if (colons !== 7) {
    return false;
  }

  text = text.replace(/^::/, "").replace(/::$/, "");
  if (text === "") {
    return true;
  }
  for (const part of text.split(":")) {
    if (part === "") {
      continue;
    }
    if (part.length > 4 || !/^[0-9A-Fa-f]{1,4}$/.test(part)) {
      return false;
    }
  }
  return true;
}

/** Validates the tag of a general address literal. */
function isValidStandardizedTag(tag: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(tag);
}
