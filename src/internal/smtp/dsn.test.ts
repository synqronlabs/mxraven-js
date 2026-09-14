import { describe, expect, it } from "vitest";

import {
  encodeXtext,
  formatDsnEnvelopeId,
  formatDsnOriginalRecipient,
  normalizeDsnNotify,
  normalizeDsnReturn,
  parseXtext,
} from "./dsn.js";

describe("parseXtext", () => {
  it("decodes escapes and preserves wire form", () => {
    const wire = "one+20two+2Bthree+3Dfour";
    expect(parseXtext(wire)).toBe("one two+three=four");
  });

  it.each(["+", "+2", "+2f", "+GG", "raw=value", "raw value"])("rejects %j", (value) => {
    expect(() => parseXtext(value)).toThrow(/dsn:/);
  });
});

describe("encodeXtext", () => {
  it("encodes reserved characters", () => {
    expect(encodeXtext("one two+three=four")).toBe("one+20two+2Bthree+3Dfour");
  });

  it("round-trips through parseXtext", () => {
    const value = "a b+c=d";
    expect(parseXtext(encodeXtext(value))).toBe(value);
  });
});

describe("normalizeDsnReturn", () => {
  it("upper-cases FULL and HDRS", () => {
    expect(normalizeDsnReturn("full")).toBe("FULL");
    expect(normalizeDsnReturn("HDRS")).toBe("HDRS");
  });

  it("rejects invalid or injected values", () => {
    expect(() => normalizeDsnReturn("PARTIAL")).toThrow(/RET/);
    expect(() => normalizeDsnReturn("FULL\r\nX: y")).toThrow(/line break/);
  });
});

describe("normalizeDsnNotify", () => {
  it("upper-cases values", () => {
    expect(normalizeDsnNotify(["success", "failure"])).toEqual(["SUCCESS", "FAILURE"]);
  });

  it("accepts NEVER alone", () => {
    expect(normalizeDsnNotify(["never"])).toEqual(["NEVER"]);
  });

  it("rejects NEVER combined with another value", () => {
    expect(() => normalizeDsnNotify(["NEVER", "SUCCESS"])).toThrow(/alone/);
  });

  it("rejects empty and unknown values", () => {
    expect(() => normalizeDsnNotify([])).toThrow(/empty/);
    expect(() => normalizeDsnNotify(["MAYBE"])).toThrow(/invalid NOTIFY/);
  });
});

describe("formatDsnEnvelopeId", () => {
  it("encodes a printable value", () => {
    expect(formatDsnEnvelopeId("env-1")).toBe("env-1");
  });

  it("rejects non-printable or empty values", () => {
    expect(() => formatDsnEnvelopeId("")).toThrow(/ENVID/);
    expect(() => formatDsnEnvelopeId("a\nb")).toThrow(/ENVID/);
  });

  it("rejects values that exceed the length limit", () => {
    expect(() => formatDsnEnvelopeId("x".repeat(200))).toThrow(/exceeds/);
  });
});

describe("formatDsnOriginalRecipient", () => {
  it("formats a non-UTF-8 address", () => {
    expect(formatDsnOriginalRecipient("rfc822", "orig@example.com", false)).toBe(
      "rfc822;orig@example.com",
    );
  });

  it("escapes non-ASCII for the utf-8 type without SMTPUTF8", () => {
    expect(formatDsnOriginalRecipient("utf-8", "ü@example.com", false)).toBe(
      "utf-8;\\x{FC}@example.com",
    );
  });

  it("keeps native UTF-8 when SMTPUTF8 is active", () => {
    expect(formatDsnOriginalRecipient("utf-8", "ü@example.com", true)).toBe("utf-8;ü@example.com");
  });

  it("rejects an invalid address type", () => {
    expect(() => formatDsnOriginalRecipient("bad type", "a@example.com", false)).toThrow(
      /address type/,
    );
  });

  it("rejects a non-printable non-UTF-8 address", () => {
    expect(() => formatDsnOriginalRecipient("rfc822", "a\nb", false)).toThrow(/decoded address/);
  });
});
