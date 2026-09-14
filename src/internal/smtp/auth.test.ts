import { describe, expect, it } from "vitest";

import { encodeLoginAuth, encodePlainAuth, selectAuthMechanism } from "./auth.js";

describe("encodePlainAuth", () => {
  it("encodes credentials as \\0username\\0password", () => {
    expect(encodePlainAuth("user", "pass")).toBe("AHVzZXIAcGFzcw==");
  });

  it("matches standard Base64 padding", () => {
    expect(encodePlainAuth("f", "")).toBe("AGYA");
  });
});

describe("encodeLoginAuth", () => {
  it.each([
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foobar", "Zm9vYmFy"],
    ["Hello, World!", "SGVsbG8sIFdvcmxkIQ=="],
  ])("encodes %j", (input, expected) => {
    expect(encodeLoginAuth(input)).toBe(expected);
  });
});

describe("selectAuthMechanism", () => {
  it("returns empty when the server offers nothing", () => {
    expect(selectAuthMechanism([], [])).toBe("");
  });

  it("matches case-insensitively and prefers PLAIN", () => {
    expect(selectAuthMechanism([], ["plain", "login"])).toBe("PLAIN");
  });

  it("honors a client preference, case-insensitively", () => {
    expect(selectAuthMechanism(["login"], ["PLAIN", "LOGIN"])).toBe("LOGIN");
  });

  it("returns empty when no client preference matches", () => {
    expect(selectAuthMechanism(["XOAUTH2"], ["PLAIN", "LOGIN"])).toBe("");
  });

  it("falls back to LOGIN when PLAIN is unavailable", () => {
    expect(selectAuthMechanism([], ["LOGIN"])).toBe("LOGIN");
  });
});
