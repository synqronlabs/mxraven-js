import { describe, expect, it } from "vitest";

import { serializeHeaders, validateHeader, validateHeaderName } from "./headers.js";

/** Splits serialized headers into their non-empty lines. */
function splitLines(value: string): string[] {
  return value.split("\r\n").filter((line) => line !== "");
}

describe("serializeHeaders", () => {
  it("does not fold a short header", () => {
    expect(serializeHeaders([{ name: "Subject", value: "Hello" }])).toBe("Subject: Hello\r\n");
  });

  it("does not fold a header at exactly the recommended limit", () => {
    const value = "This is exactly at the seventy-eight character limit, yes it is!!!!!!";
    expect(value).toHaveLength(69);
    expect(serializeHeaders([{ name: "Subject", value }])).toBe(`Subject: ${value}\r\n`);
  });

  it("folds a long header at whitespace", () => {
    const value =
      "This is a longer subject line that will definitely need to be folded at whitespace";
    const lines = splitLines(serializeHeaders([{ name: "Subject", value }]));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    for (const line of lines.slice(1)) {
      expect(line.startsWith(" ") || line.startsWith("\t")).toBe(true);
    }
  });

  it("collapses consecutive whitespace at fold points", () => {
    const value =
      "word1 word2  word3   word4    word5 word6 word7 word8 word9 word10 word11 word12 word13";
    for (const line of splitLines(serializeHeaders([{ name: "Subject", value }])).slice(1)) {
      expect(line.startsWith("  ")).toBe(false);
    }
  });

  it("folds on tabs", () => {
    const value = "word1\tword2\tword3 word4 word5 word6 word7 word8 word9 word10 word11 word12";
    const lines = splitLines(serializeHeaders([{ name: "Subject", value }]));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
  });

  it("never exceeds the maximum line length for an unbreakable value", () => {
    const value =
      "ThisIsAVeryLongWordWithNoWhitespaceAtAllAndItJustKeepsGoingAndGoingAndGoingUntilItExceedsTheMaximumLineLength";
    for (const line of splitLines(serializeHeaders([{ name: "X-Long", value }]))) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it("serializes an empty value", () => {
    expect(serializeHeaders([{ name: "X-Empty", value: "" }])).toBe("X-Empty: \r\n");
  });

  it("serializes a whitespace-only value with a terminating CRLF", () => {
    const serialized = serializeHeaders([{ name: "X-Spaces", value: "   " }]);
    expect(serialized.endsWith("\r\n")).toBe(true);
  });

  it("preserves content after unfolding", () => {
    const value =
      "This is a test value with multiple words that should be folded and then unfolded correctly";
    const serialized = serializeHeaders([{ name: "Subject", value }]);
    const unfolded = serialized
      .slice("Subject: ".length, -2)
      .replace(/\r\n[ \t]+/g, " ")
      .replace(/[ \t]+/g, " ");
    expect(unfolded).toBe(value.replace(/[ \t]+/g, " "));
  });
});

describe("validateHeader", () => {
  it("rejects CRLF injection", () => {
    expect(() => validateHeader("Subject", "ok\r\nX-Injected: bad")).toThrow(/line break/);
  });

  it("rejects an invalid header name", () => {
    expect(() => validateHeaderName("Bad Header")).toThrow(/invalid header name/);
  });

  it("accepts a normal header", () => {
    expect(() => validateHeader("X-Campaign", "launch")).not.toThrow();
  });
});
