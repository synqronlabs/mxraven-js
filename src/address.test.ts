import { describe, expect, it } from "vitest";

import {
  encodeRfc2047,
  formatAddress,
  formatAddressList,
  mailboxToString,
  parseAddress,
  parseAddressList,
} from "./address.js";
import { AddressError, addressErrorKind } from "./errors.js";
import { containsNonAscii } from "./internal/ascii.js";

describe("parseAddress", () => {
  it.each([
    ["user@example.com", { localPart: "user", domain: "example.com" }],
    ["User@Example.COM", { localPart: "User", domain: "example.com" }],
    ["<a@b.co>", { localPart: "a", domain: "b.co" }],
    ["a@b", { localPart: "a", domain: "b" }],
    ["user@localhost", { localPart: "user", domain: "localhost" }],
    [
      "Acme <noreply@acme.example>",
      { localPart: "noreply", domain: "acme.example", displayName: "Acme" },
    ],
    [
      '"Doe, John" <john@example.com>',
      { localPart: "john", domain: "example.com", displayName: "Doe, John" },
    ],
    ["Jöhn <john@example.com>", { localPart: "john", domain: "example.com", displayName: "Jöhn" }],
  ])("parses %s", (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it("unquotes a quoted local part", () => {
    // RFC 5321 section 4.1.2: quoting is presentation, not part of the mailbox.
    expect(parseAddress('"john doe"@example.com')).toEqual({
      localPart: "john doe",
      domain: "example.com",
    });
    expect(parseAddress('"a@b"@example.com')).toEqual({ localPart: "a@b", domain: "example.com" });
    expect(parseAddress('""@example.com')).toEqual({ localPart: "", domain: "example.com" });
  });

  it("accepts a hyphen inside a DNS label", () => {
    expect(parseAddress("user@ex--ample.com").domain).toBe("ex--ample.com");
  });

  it("unfolds whitespace inside a quoted local part", () => {
    // RFC 5322 unfolding removes the CRLF and keeps the whitespace.
    expect(parseAddress('"a\r\n b"@example.com')).toEqual({
      localPart: "a b",
      domain: "example.com",
    });
  });

  it("lowercases an ASCII domain and keeps the local part case", () => {
    expect(parseAddress("John.Doe@Example.COM")).toEqual({
      localPart: "John.Doe",
      domain: "example.com",
    });
  });

  it.each([
    ["user@例え.jp", "xn--r8jz45g.jp"],
    ["user@BÜCHER.de", "xn--bcher-kva.de"],
    ["user@bücher.de", "xn--bcher-kva.de"],
    ["user@münchen.de", "xn--mnchen-3ya.de"],
    ["user@faß.de", "xn--fa-hia.de"],
    ["user@ｅｘａｍｐｌｅ.com", "example.com"],
    ["user@example。com", "example.com"],
    ["user@☃.net", "xn--n3h.net"],
    ["user@xn--bcher-kva.de", "xn--bcher-kva.de"],
    ["user@XN--BCHER-KVA.DE", "xn--bcher-kva.de"],
    ["user@例え.tokyo", "xn--r8jz45g.tokyo"],
    ["user@日本語.jp", "xn--wgv71a119e.jp"],
    ["user@123.例え.jp", "123.xn--r8jz45g.jp"],
    ["user@e\u0301xample.com", "xn--xample-9ua.com"],
  ])("normalizes the domain of %s", (input, domain) => {
    expect(parseAddress(input).domain).toBe(domain);
  });

  it.each([
    ["user@[192.0.2.1]", "[192.0.2.1]"],
    ["user@[ 192.0.2.1 ]", "[192.0.2.1]"],
    ["user@[IPv6:2001:db8::1]", "[IPv6:2001:db8::1]"],
    ["user@[IPv6:::1]", "[IPv6:::1]"],
    ["user@[IPv6:::ffff:192.0.2.1]", "[IPv6:::ffff:192.0.2.1]"],
    ["user@[X400:abc]", "[X400:abc]"],
  ])("parses the domain literal in %s", (input, domain) => {
    expect(parseAddress(input).domain).toBe(domain);
  });
});

describe("parseAddress with CFWS and obsolete syntax", () => {
  it.each([
    ["user@example.com (Comment)", { localPart: "user", domain: "example.com" }],
    ["(a) user@example.com (b)", { localPart: "user", domain: "example.com" }],
    [
      "John (middle) Doe <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Doe" },
    ],
    [
      "John\r\n Doe <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Doe" },
    ],
    [
      "John  Doe <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Doe" },
    ],
    [
      'John" Q" Public <john@example.com>',
      { localPart: "john", domain: "example.com", displayName: "John Q Public" },
    ],
    ["(lead) user@example.com", { localPart: "user", domain: "example.com" }],
    ["< john@example.com >", { localPart: "john", domain: "example.com" }],
    ["user@example.com (a \\)b)", { localPart: "user", domain: "example.com" }],
    [
      "(before) John Doe (after) <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Doe" },
    ],
  ])("parses %j", (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it.each([
    ["John.Doe <john@example.com>", "John.Doe"],
    ["John . Doe <john@example.com>", "John . Doe"],
    ["John Q. Public <john@example.com>", "John Q. Public"],
  ])("preserves the dots of the display name in %j", (input, displayName) => {
    expect(parseAddress(input).displayName).toBe(displayName);
  });

  it.each([
    ["user . name@example.com", "user.name"],
    ["user (c) . name@example.com", "user.name"],
    ["user. (c) name@example.com", "user.name"],
    ["user.(c)name@example.com", "user.name"],
  ])("normalizes the obsolete local part in %j", (input, localPart) => {
    expect(parseAddress(input).localPart).toBe(localPart);
  });

  it.each([
    ["user@exam . com", "exam.com"],
    ["user@exam (c) . com", "exam.com"],
  ])("normalizes the obsolete domain in %j", (input, domain) => {
    expect(parseAddress(input).domain).toBe(domain);
  });
});

describe("parseAddress with encoded words", () => {
  it.each([
    ["=?UTF-8?B?SsO2aG4=?= <j@x.com>", "Jöhn"],
    ["=?utf-8?q?J=C3=B6hn?= <j@x.com>", "Jöhn"],
    ["=?UTF-8?B?SsO2aG4=?= =?UTF-8?B?IERvZQ==?= <j@x.com>", "Jöhn Doe"],
    ["=?UTF-8?B?SsO2aG4=?= Doe <j@x.com>", "Jöhn Doe"],
    ["Joe =?UTF-8?B?QsO2Yg==?= <j@x.com>", "Joe Böb"],
    ["=?ISO-8859-1?Q?J=F6hn?= <j@x.com>", "Jöhn"],
    ["=?US-ASCII?Q?John?= <j@x.com>", "John"],
    ["=?WINDOWS-1252?Q?J=F6hn?= <j@x.com>", "Jöhn"],
    ["=?ISO-8859-1?Q?=93Q=94_Quotes?= <j@x.com>", "\u201cQ\u201d Quotes"],
    ["=?utf-8?X?John?= <j@x.com>", "=?utf-8?X?John?="],
    ["=?utf-8?B?!!!!?= <j@x.com>", "=?utf-8?B?!!!!?="],
    ["=?UTF-8?B?SsO2aG4?= <j@x.com>", "=?UTF-8?B?SsO2aG4?="],
  ])("decodes the display name of %j", (input, displayName) => {
    expect(parseAddress(input).displayName).toBe(displayName);
  });

  it("rejects an encoded word with an unknown character set", () => {
    expect(() => parseAddress("=?x-unknown?B?SsO2aG4=?= <a@b.com>")).toThrow(
      expect.objectContaining({ kind: addressErrorKind.unsupportedCharset }),
    );
  });

  it.each([
    "=?UTF-8?Q?Acme=0D=0ABcc=3A_x?= <a@b.com>",
    "=?UTF-8?Q?Acme=0A_x?= <a@b.com>",
    "=?UTF-8?Q?Acme=01_x?= <a@b.com>",
  ])("rejects the control characters decoded from %j", (input) => {
    // Rust-style header injection through RFC 2047 must never round-trip.
    expect(() => parseAddress(input)).toThrow(
      expect.objectContaining({ kind: addressErrorKind.invalidHeaderValue }),
    );
  });
});

describe("parseAddress rejections", () => {
  it.each<[string, string]>([
    ["", addressErrorKind.invalidAddress],
    ["   ", addressErrorKind.invalidAddress],
    ["a b@example.com", addressErrorKind.invalidAddress],
    ["user@exam ple.com", addressErrorKind.invalidAddress],
    ["Name <user@example.com> extra", addressErrorKind.invalidAddress],
    ["Group: a@b.co;", addressErrorKind.invalidAddress],
    ["a@b.com, c@d.com", addressErrorKind.invalidAddress],
    ["a@b@c.com", addressErrorKind.invalidAddress],
    ["user", addressErrorKind.invalidAddress],
    ["@example.com", addressErrorKind.localPartEmpty],
    ["user@", addressErrorKind.domainEmpty],
    ["user@.com", addressErrorKind.invalidDomain],
    ["user@a_b.com", addressErrorKind.invalidDomain],
    ["user@_dmarc.example.com", addressErrorKind.invalidDomain],
    ["user@-x.com", addressErrorKind.invalidDomain],
    ["user@x-.com", addressErrorKind.invalidDomain],
    ['"a\tb"@example.com', addressErrorKind.invalidLocalPart],
    ['"a\u0085b"@example.com', addressErrorKind.invalidLocalPart],
    ['"a\u2028b"@example.com', addressErrorKind.invalidLocalPart],
    ["user@example..com", addressErrorKind.invalidDomain],
    ["user@例え-.jp", addressErrorKind.invalidDomain],
    ["user@例え.\u200b.jp", addressErrorKind.invalidDomain],
    ["user@[notip]", addressErrorKind.invalidDomainLiteral],
    ["user@[]", addressErrorKind.invalidDomainLiteral],
    ["user@[192.168.01.1]", addressErrorKind.invalidDomainLiteral],
    ["user@[IPv6:zz]", addressErrorKind.invalidDomainLiteral],
    ["Name <>", addressErrorKind.invalidLocalPart],
    [". John <a@b.com>", addressErrorKind.invalidAddress],
    ["<@relay:user@b.com>", addressErrorKind.invalidLocalPart],
    ["user@example.com\r\nBcc: attacker@example.com", addressErrorKind.invalidLineEnding],
    ['"John\r\nBcc: attacker@example.com" <a@b.com>', addressErrorKind.invalidLineEnding],
    ["John\r\nBcc: attacker@example.com <a@b.com>", addressErrorKind.invalidLineEnding],
    ["John\nDoe <a@b.com>", addressErrorKind.invalidLineEnding],
    ["(unterminated <a@b.com>", addressErrorKind.invalidHeaderValue],
    ["John <a@b.com", addressErrorKind.invalidAddress],
    [`${"a".repeat(65)}@example.com`, addressErrorKind.localPartTooLong],
    [`user@${"a".repeat(64)}.com`, addressErrorKind.invalidDomain],
    [`user@${"a.".repeat(200)}com`, addressErrorKind.domainTooLong],
    [`${"a".repeat(64)}@${`${"b".repeat(60)}.`.repeat(4)}com`, addressErrorKind.addressTooLong],
    ["\uD800@example.com", addressErrorKind.invalidUtf8],
    ["user@\uDC00.example", addressErrorKind.invalidUtf8],
  ])("rejects %j as %s", (input, kind) => {
    let thrown: unknown;
    try {
      parseAddress(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AddressError);
    expect((thrown as AddressError).kind).toBe(kind);
  });
});

describe("parseAddressList", () => {
  it.each([
    ["user@example.com", ["user@example.com"]],
    ["a@example.com, b@example.com", ["a@example.com", "b@example.com"]],
    ['"Doe, John" <john@example.com>, jane@example.com', ["john@example.com", "jane@example.com"]],
    [",a@example.com", ["a@example.com"]],
    [", , a@example.com, b@example.com", ["a@example.com", "b@example.com"]],
    ["", []],
    ["   ", []],
    ["undisclosed-recipients:;", []],
    ["undisclosed-recipients: ,;", []],
    ["Friends: a@example.com, b@example.com;", ["a@example.com", "b@example.com"]],
    ["Friends:;", []],
    ["undisclosed-recipients:;, a@example.com", ["a@example.com"]],
  ])("parses %j", (input, expected) => {
    expect(parseAddressList(input).map(mailboxToString)).toEqual(expected);
  });

  it("keeps each member's display name", () => {
    expect(parseAddressList('Friends: "Doe, John" <j@example.com>;')).toEqual([
      { localPart: "j", domain: "example.com", displayName: "Doe, John" },
    ]);
  });

  it.each([
    ["a@example.com;", "a semicolon outside a group"],
    ["a@example.com,", "a trailing comma"],
    ["a@example.com,, b@example.com", "an empty element"],
    [",", "a list with no address"],
    ["Friends: a@example.com", "a group without a semicolon"],
    ["Friends: a@example.com,;", "a trailing comma in a group"],
    ["Friends: ,a@example.com;", "a leading comma before a group member"],
    ["Friends: Other: a@example.com;;", "a nested group"],
    ["a@example.com b@example.com", "a missing comma"],
  ])("rejects %j with %s", (input) => {
    expect(() => parseAddressList(input)).toThrow(AddressError);
  });
});

describe("mailboxToString", () => {
  it("returns the bare address", () => {
    expect(mailboxToString({ localPart: "user", domain: "example.com" })).toBe("user@example.com");
  });

  it("re-quotes a local part that is not a dot-string", () => {
    expect(mailboxToString({ localPart: "john doe", domain: "example.com" })).toBe(
      '"john doe"@example.com',
    );
    expect(mailboxToString({ localPart: "a@b", domain: "example.com" })).toBe('"a@b"@example.com');
    expect(mailboxToString({ localPart: "", domain: "example.com" })).toBe('""@example.com');
  });

  it("does not quote a local part that is a dot-string", () => {
    expect(mailboxToString({ localPart: "john.doe", domain: "example.com" })).toBe(
      "john.doe@example.com",
    );
  });

  it("returns an empty string for an empty mailbox", () => {
    expect(mailboxToString({ localPart: "", domain: "" })).toBe("");
  });
});

describe("formatAddress", () => {
  it("formats a bare address", () => {
    expect(formatAddress({ localPart: "user", domain: "example.com" })).toBe("user@example.com");
  });

  it("formats a display name", () => {
    expect(
      formatAddress({ localPart: "noreply", domain: "acme.example", displayName: "Acme" }),
    ).toBe("Acme <noreply@acme.example>");
  });

  it.each([
    ["Doe, John", '"Doe, John" <john@example.com>'],
    ["John Q. Public", '"John Q. Public" <john@example.com>'],
    ["Acme! Inc", "Acme! Inc <john@example.com>"],
    ["John  Q", '"John  Q" <john@example.com>'],
    [" John", '" John" <john@example.com>'],
  ])("quotes the display name %j when required", (displayName, expected) => {
    expect(formatAddress({ localPart: "john", domain: "example.com", displayName })).toBe(expected);
  });

  it("encodes a non-ASCII display name", () => {
    const formatted = formatAddress({
      localPart: "john",
      domain: "example.com",
      displayName: "Jöhn",
    });
    expect(formatted).toBe("=?UTF-8?B?SsO2aG4=?= <john@example.com>");
  });

  it("splits a long encoded display name into conforming words", () => {
    const formatted = formatAddress({
      localPart: "john",
      domain: "example.com",
      displayName: "ä".repeat(60),
    });
    const words = formatted.slice(0, formatted.indexOf(" <")).split(" ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it("escapes the display name so it survives a round trip", () => {
    const original = parseAddress('"A\\\\B, C" <a@example.com>');
    expect(original.displayName).toBe("A\\B, C");

    const formatted = formatAddress(original);
    expect(formatted).toBe('"A\\\\B, C" <a@example.com>');
    expect(parseAddress(formatted)).toEqual(original);
  });

  it("rejects a display name containing a control character", () => {
    expect(() =>
      formatAddress({ localPart: "a", domain: "b.com", displayName: "Acme\r\nBcc: x" }),
    ).toThrow(expect.objectContaining({ kind: addressErrorKind.invalidHeaderValue }));
  });

  it("joins address lists", () => {
    expect(
      formatAddressList([
        { localPart: "a", domain: "example.com" },
        { localPart: "b", domain: "example.com" },
      ]),
    ).toBe("a@example.com, b@example.com");
  });
});

describe("address round trips", () => {
  it.each([
    "user@example.com",
    "Acme <noreply@acme.example>",
    '"Doe, John" <john@example.com>',
    '"A\\\\B" <a@example.com>',
    '"john doe"@example.com',
    "Jöhn <john@example.com>",
    "user@例え.jp",
    "user@[192.0.2.1]",
    "=?UTF-8?B?SsO2aG4=?= <j@x.com>",
    "user@example.com (Comment)",
    '"John  Q Public" <john@example.com>',
    '" John " <john@example.com>',
    '"  " <john@example.com>',
  ])("preserves %j through parse, format, and parse", (input) => {
    const first = parseAddress(input);
    expect(parseAddress(formatAddress(first))).toEqual(first);
  });
});

describe("encodeRfc2047", () => {
  it("encodes a short value as a single word", () => {
    expect(encodeRfc2047("Jöhn")).toBe("=?UTF-8?B?SsO2aG4=?=");
  });

  it("never splits a multi-byte character between words", () => {
    const original = "😀".repeat(20);
    let decoded = "";
    for (const word of encodeRfc2047(original).split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75);
      const payload = word.slice("=?UTF-8?B?".length, -2);
      decoded += Buffer.from(payload, "base64").toString("utf8");
      expect(decoded).not.toContain("\uFFFD");
    }
    expect(decoded).toBe(original);
  });
});

describe("containsNonAscii", () => {
  it.each([
    ["empty string", "", false],
    ["pure ASCII lowercase", "hello world", false],
    ["ASCII with symbols", "hello!@#$%^&*()_+-=", false],
    ["email address", "user@example.com", false],
    ["ASCII with newlines", "hello\r\nworld", false],
    ["single non-ASCII character", "ä", true],
    ["UTF-8 emoji", "hello 👋", true],
    ["Chinese characters", "你好", true],
    ["boundary ASCII (127)", String.fromCharCode(127), false],
  ])("classifies $0", (_name, input, expected) => {
    expect(containsNonAscii(input)).toBe(expected);
  });
});
