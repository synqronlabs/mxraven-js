import { describe, expect, it } from "vitest";

import { decodeHeaderWords } from "./encoded-word.js";

describe("decodeHeaderWords", () => {
  it("returns text without encoded words unchanged", () => {
    expect(decodeHeaderWords("John Doe")).toBe("John Doe");
    expect(decodeHeaderWords("")).toBe("");
  });

  it.each([
    ["=?UTF-8?B?SsO2aG4=?=", "Jöhn"],
    ["=?utf-8?b?SsO2aG4=?=", "Jöhn"],
    ["=?UTF-8?Q?J=C3=B6hn?=", "Jöhn"],
    ["=?UTF-8?q?J=C3=B6hn?=", "Jöhn"],
    ["=?UTF-8?Q?J=2Ehn?=", "J.hn"],
    ["=?UTF-8?Q?J_hn?=", "J hn"],
    ["=?UTF-8?B??=", ""],
    ["=?UTF-8?Q??=", ""],
  ])("decodes %j", (input, expected) => {
    expect(decodeHeaderWords(input)).toBe(expected);
  });

  it("decodes encoded words embedded in text", () => {
    expect(decodeHeaderWords("Joe =?UTF-8?B?QsO2Yg==?= Jr")).toBe("Joe Böb Jr");
    expect(decodeHeaderWords("John=?UTF-8?B?IEI=?=")).toBe("John B");
  });

  it("removes whitespace between adjacent encoded words", () => {
    expect(decodeHeaderWords("=?UTF-8?B?SsO2aG4=?= =?UTF-8?B?IERvZQ==?=")).toBe("Jöhn Doe");
    expect(decodeHeaderWords("=?UTF-8?B?SsO2aG4=?=\t=?UTF-8?B?IERvZQ==?=")).toBe("Jöhn Doe");
  });

  it("keeps whitespace before a single encoded word", () => {
    expect(decodeHeaderWords("=?UTF-8?B?QS1C?= tail")).toBe("A-B tail");
  });

  it("decodes the RFC 2047 ASCII and Latin-1 character sets", () => {
    expect(decodeHeaderWords("=?US-ASCII?Q?John?=")).toBe("John");
    expect(decodeHeaderWords("=?ISO-8859-1?Q?J=F6hn?=")).toBe("Jöhn");
    expect(decodeHeaderWords("=?iso-8859-1?B?SvZo?=")).toBe("Jöh");
  });

  it("treats ISO-8859-1 as its windows-1252 superset", () => {
    // Bytes 0x80-0x9F would be C1 controls under strict ISO-8859-1; senders and
    // every common client mean the windows-1252 punctuation.
    expect(decodeHeaderWords("=?ISO-8859-1?Q?=93Hi=94?=")).toBe("\u201cHi\u201d");
    expect(decodeHeaderWords("=?latin1?Q?=93Hi=94?=")).toBe("\u201cHi\u201d");
  });

  it("replaces bytes outside US-ASCII with the replacement character", () => {
    expect(decodeHeaderWords("=?US-ASCII?B?/w==?=")).toBe("\uFFFD");
  });

  it("decodes a character set the platform supports", () => {
    expect(decodeHeaderWords("=?WINDOWS-1252?Q?=93Hi=94?=")).toBe("\u201cHi\u201d");
  });

  it("reports an unsupported character set", () => {
    expect(decodeHeaderWords("=?x-unknown?B?SsO2aG4=?=")).toBeUndefined();
    expect(decodeHeaderWords("=??B?SsO2aG4=?=")).toBeUndefined();
  });

  it("reports invalid UTF-8 as the replacement character", () => {
    // Go keeps the raw bytes; a JavaScript string cannot, so this is a
    // documented divergence.
    expect(decodeHeaderWords("=?UTF-8?B?/w==?=")).toBe("\uFFFD");
  });

  it.each([
    ["=?utf-8?X?John?=", "an unknown transfer encoding"],
    ["=?utf-8?B?!!!!?=", "invalid Base64"],
    ["=?utf-8?B?SsO2aG4?=", "a missing terminator"],
    ["=?utf-8?Q?J=ZZhn?=", "an invalid Q escape"],
    ["=?UTF-8?Q?Jöhn?=", "a non-ASCII Q payload"],
  ])("passes through %j with %s", (input) => {
    expect(decodeHeaderWords(input)).toBe(input);
  });

  it("passes through a malformed word and still decodes a following one", () => {
    expect(decodeHeaderWords("=?utf-8?B?!!!!?= =?UTF-8?B?QQ==?=")).toBe("=?utf-8?B?!!!!?= A");
  });
});
