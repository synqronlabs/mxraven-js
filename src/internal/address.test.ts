import { describe, expect, it } from "vitest";

import {
  containsNonAscii,
  formatAddress,
  formatAddressList,
  mailboxToString,
  parseAddress,
} from "./address.js";

describe("parseAddress", () => {
  it.each([
    ["user@example.com", { localPart: "user", domain: "example.com" }],
    ["<a@b.co>", { localPart: "a", domain: "b.co" }],
    [
      "Acme <noreply@acme.example>",
      { localPart: "noreply", domain: "acme.example", displayName: "Acme" },
    ],
    [
      '"Doe, John" <john@example.com>',
      { localPart: "john", domain: "example.com", displayName: "Doe, John" },
    ],
    ['"john doe"@example.com', { localPart: "john doe", domain: "example.com" }],
    ["Jöhn <john@example.com>", { localPart: "john", domain: "example.com", displayName: "Jöhn" }],
  ])("parses %s", (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it.each([
    "",
    "   ",
    "a b@example.com",
    "user@",
    "@example.com",
    "user@exam ple.com",
    "a\nb@example.com",
    "Name <>",
    "Name <user@example.com> extra",
  ])("rejects %j", (input) => {
    expect(() => parseAddress(input)).toThrow(/mail:/);
  });
});

describe("parseAddress with CFWS", () => {
  it.each([
    [
      "user@example.com (Comment)",
      { localPart: "user", domain: "example.com", displayName: "Comment" },
    ],
    [
      "John (middle) Doe <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Doe" },
    ],
    [
      "John\r\n Doe <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Doe" },
    ],
    [
      "John Q. Public <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Q. Public" },
    ],
    ["(lead) user@example.com", { localPart: "user", domain: "example.com" }],
    ["< john@example.com >", { localPart: "john", domain: "example.com" }],
    ["user@[192.0.2.1]", { localPart: "user", domain: "[192.0.2.1]" }],
    [
      "user@example.com (a \\)b)",
      { localPart: "user", domain: "example.com", displayName: "a )b" },
    ],
    [
      "(before) John Doe (after) <john@example.com>",
      { localPart: "john", domain: "example.com", displayName: "John Doe" },
    ],
  ])("parses %j", (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it.each([
    "John\nDoe <john@example.com>",
    "user@example.com\r\nBcc: attacker@example.com",
    "John <john@example.com",
    "John Doe",
    "user@example.com extra",
    "(unterminated <john@example.com>",
  ])("rejects %j", (input) => {
    expect(() => parseAddress(input)).toThrow(/mail:/);
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

  it("quotes a display name containing specials", () => {
    expect(
      formatAddress({ localPart: "john", domain: "example.com", displayName: "Doe, John" }),
    ).toBe('"Doe, John" <john@example.com>');
  });

  it("encodes a non-ASCII display name", () => {
    const formatted = formatAddress({
      localPart: "john",
      domain: "example.com",
      displayName: "Jöhn",
    });
    expect(formatted.startsWith("=?UTF-8?B?")).toBe(true);
    expect(formatted.endsWith("?= <john@example.com>")).toBe(true);
  });

  it("re-quotes a quoted local part", () => {
    expect(formatAddress({ localPart: "john doe", domain: "example.com" })).toBe(
      '"john doe"@example.com',
    );
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

describe("mailboxToString", () => {
  it("returns the bare address", () => {
    expect(mailboxToString({ localPart: "user", domain: "example.com" })).toBe("user@example.com");
  });

  it("returns an empty string for an empty mailbox", () => {
    expect(mailboxToString({ localPart: "", domain: "" })).toBe("");
  });
});

describe("containsNonAscii", () => {
  it.each([
    ["empty string", "", false],
    ["pure ASCII lowercase", "hello world", false],
    ["pure ASCII with numbers", "hello123world", false],
    ["pure ASCII with symbols", "hello!@#$%^&*()_+-=", false],
    ["email address", "user@example.com", false],
    ["ASCII with newlines", "hello\r\nworld", false],
    ["ASCII with tabs", "hello\tworld", false],
    ["single non-ASCII character", "ä", true],
    ["UTF-8 umlaut", "hello wörld", true],
    ["UTF-8 emoji", "hello 👋", true],
    ["Chinese characters", "你好", true],
    ["mixed ASCII and UTF-8", "hello世界", true],
    ["international email-like", "user@exämple.com", true],
    ["high ASCII byte", String.fromCharCode(0x80), true],
    ["boundary ASCII (127)", String.fromCharCode(127), false],
  ])("classifies $0", (_name, input, expected) => {
    expect(containsNonAscii(input)).toBe(expected);
  });
});
