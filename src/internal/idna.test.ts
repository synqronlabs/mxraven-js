import { describe, expect, it } from "vitest";

import { decodePunycode, encodePunycode, toAsciiDomain } from "./idna.js";

describe("toAsciiDomain", () => {
  it.each([
    ["例え.jp", "xn--r8jz45g.jp"],
    ["日本語.jp", "xn--wgv71a119e.jp"],
    ["münchen.de", "xn--mnchen-3ya.de"],
    ["MÜNCHEN.DE", "xn--mnchen-3ya.de"],
    ["b\u00fcCHER.de", "xn--bcher-kva.de"],
    ["faß.de", "xn--fa-hia.de"],
    ["☃.net", "xn--n3h.net"],
    ["123.例え.jp", "123.xn--r8jz45g.jp"],
    ["e\u0301xample.com", "xn--xample-9ua.com"],
    ["example.例え", "example.xn--r8jz45g"],
  ])("converts %j to an A-label", (input, expected) => {
    expect(toAsciiDomain(input)).toBe(expected);
  });

  it.each([
    ["ｅｘａｍｐｌｅ.com", "example.com"],
    ["ＡＢＣ.jp", "abc.jp"],
    ["ﬁle.com", "file.com"],
    ["example。com", "example.com"],
    ["例え。ｊｐ", "xn--r8jz45g.jp"],
    ["例え．ｊｐ", "xn--r8jz45g.jp"],
  ])("applies the UTS #46 mapping to %j", (input, expected) => {
    expect(toAsciiDomain(input)).toBe(expected);
  });

  it.each([
    ["xn--bcher-kva.de", "xn--bcher-kva.de"],
    ["XN--BCHER-KVA.DE", "xn--bcher-kva.de"],
    ["xn--bcher-kva.例え.jp", "xn--bcher-kva.xn--r8jz45g.jp"],
  ])("validates and lowercases the existing A-label in %j", (input, expected) => {
    expect(toAsciiDomain(input)).toBe(expected);
  });

  it.each([
    ["例え.jp.", "a trailing empty label"],
    [".例え.jp", "a leading empty label"],
    ["例え..jp", "an empty label"],
    ["例え.\u200b.jp", "a label that maps to nothing"],
    ["例え-.jp", "a trailing hyphen"],
    ["-例え.jp", "a leading hyphen"],
    ["例え.x-.com", "a trailing hyphen in an ASCII label"],
    ["例え.-x.com", "a leading hyphen in an ASCII label"],
    ["例え._x.com", "an underscore next to an internationalized label"],
    ["ab--例え.com", "a hyphen in positions three and four"],
    ["例え.\u0301abc.com", "a leading combining mark"],
    ["例え.\u00a0.jp", "a no-break space"],
    ["例え.\u200d.jp", "a zero-width joiner"],
    ["例え.\uFFFD.jp", "a replacement character"],
    ["xn--zzzz.例え.jp", "an A-label that decodes to ASCII"],
    ["xn--abc.例え.jp", "an A-label that decodes to disallowed code points"],
    ["xn--.例え.jp", "an empty A-label payload"],
  ])("rejects %j with %s", (input) => {
    expect(toAsciiDomain(input)).toBeUndefined();
  });

  it("ignores code points that UTS #46 maps to nothing", () => {
    expect(toAsciiDomain("例\u200b\u00adえ.jp")).toBe("xn--r8jz45g.jp");
    expect(toAsciiDomain("example\ufeff.com")).toBe("example.com");
  });

  it("rejects an unassigned code point", () => {
    expect(toAsciiDomain("例え.\u0378.com")).toBeUndefined();
  });
});

describe("encodePunycode", () => {
  it.each([
    ["例え", "r8jz45g"],
    ["bücher", "bcher-kva"],
    ["münchen", "mnchen-3ya"],
    ["☃", "n3h"],
  ])("encodes %j", (input, expected) => {
    expect(encodePunycode(input)).toBe(expected);
  });

  it("rejects a lone surrogate", () => {
    expect(encodePunycode("\uD800abc")).toBeUndefined();
  });

  it("round-trips through the decoder", () => {
    for (const value of ["例え", "bücher", "☃", "日本語", "😀", "ab", "例子.广告"]) {
      const encoded = encodePunycode(value);
      expect(encoded).toBeDefined();
      expect(decodePunycode(encoded ?? "")).toBe(value);
    }
  });
});

describe("decodePunycode", () => {
  it.each([
    ["r8jz45g", "例え"],
    ["bcher-kva", "bücher"],
    ["n3h", "☃"],
  ])("decodes %j", (input, expected) => {
    expect(decodePunycode(input)).toBe(expected);
  });

  it("returns an empty string for an empty payload", () => {
    expect(decodePunycode("")).toBe("");
  });

  it("rejects a payload with characters outside the Punycode alphabet", () => {
    expect(decodePunycode("r8jz45g!")).toBeUndefined();
    expect(decodePunycode("例え")).toBeUndefined();
  });

  it("does not treat an ASCII-only payload as a literal label", () => {
    expect(decodePunycode("abc")).not.toBe("abc");
  });
});
