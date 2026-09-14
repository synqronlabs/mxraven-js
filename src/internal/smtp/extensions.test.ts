import { describe, expect, it } from "vitest";

import { capabilitiesFrom, parseExtensions, smtpExtension } from "./extensions.js";

describe("parseExtensions", () => {
  it("parses names and parameters and skips the greeting line", () => {
    const extensions = parseExtensions([
      "mock.example.com Hello",
      "SIZE 10485760",
      "PIPELINING",
      "8BITMIME",
      "AUTH PLAIN LOGIN",
      "STARTTLS",
      "ENHANCEDSTATUSCODES",
      "SMTPUTF8",
      "DSN",
      "CHUNKING",
      "BINARYMIME",
      "DELIVERBY 300",
    ]);

    expect(extensions.get(smtpExtension.size)).toBe("10485760");
    expect(extensions.get(smtpExtension.pipelining)).toBe("");
    expect(extensions.get(smtpExtension.eightBitMime)).toBe("");
    expect(extensions.get(smtpExtension.auth)).toBe("PLAIN LOGIN");
    expect(extensions.get(smtpExtension.startTls)).toBe("");
    expect(extensions.get(smtpExtension.enhancedStatusCodes)).toBe("");
    expect(extensions.get(smtpExtension.smtpUtf8)).toBe("");
    expect(extensions.get(smtpExtension.dsn)).toBe("");
    expect(extensions.get(smtpExtension.chunking)).toBe("");
    expect(extensions.get(smtpExtension.binaryMime)).toBe("");
    expect(extensions.get(smtpExtension.deliverBy)).toBe("300");
  });

  it("returns no extensions for a greeting-only reply", () => {
    expect(parseExtensions(["mock.example.com Hello"]).size).toBe(0);
  });

  it("parses a single extension", () => {
    expect(parseExtensions(["mock.example.com", "PIPELINING"]).has("PIPELINING")).toBe(true);
  });
});

describe("capabilitiesFrom", () => {
  it("exposes boolean capabilities and accessors", () => {
    const extensions = parseExtensions([
      "mock.example.com",
      "STARTTLS",
      "AUTH PLAIN LOGIN",
      "SIZE 52428800",
      "PIPELINING",
      "8BITMIME",
      "SMTPUTF8",
      "DSN",
      "CHUNKING",
      "BINARYMIME",
      "ENHANCEDSTATUSCODES",
      "DELIVERBY 300",
    ]);
    const capabilities = capabilitiesFrom(extensions, true, "mock.example.com");

    expect(capabilities.isEsmtp).toBe(true);
    expect(capabilities.hostname).toBe("mock.example.com");
    expect(capabilities.tls).toBe(true);
    expect(capabilities.pipelining).toBe(true);
    expect(capabilities.eightBitMime).toBe(true);
    expect(capabilities.smtpUtf8).toBe(true);
    expect(capabilities.dsn).toBe(true);
    expect(capabilities.chunking).toBe(true);
    expect(capabilities.binaryMime).toBe(true);
    expect(capabilities.enhancedStatusCodes).toBe(true);
    expect(capabilities.deliveryBy).toBe(true);
    expect(capabilities.deliveryByMinSeconds).toBe(300);
    expect(capabilities.maxSize).toBe(52428800);
    expect(capabilities.auth).toEqual(["PLAIN", "LOGIN"]);
    expect(capabilities.supportsAuth("plain")).toBe(true);
    expect(capabilities.supportsAuth("CRAM-MD5")).toBe(false);
    expect(capabilities.hasExtension(smtpExtension.pipelining)).toBe(true);
    expect(capabilities.hasExtension("X-NOT-ADVERTISED")).toBe(false);
    expect(capabilities.getExtensionParam(smtpExtension.size)).toBe("52428800");
    expect(capabilities.getExtensionParam(smtpExtension.pipelining)).toBe("");
  });

  it("returns 0 for an invalid SIZE parameter", () => {
    const capabilities = capabilitiesFrom(new Map([[smtpExtension.size, "notanumber"]]), false, "");
    expect(capabilities.maxSize).toBe(0);
  });

  it("returns 0 for an empty SIZE parameter", () => {
    const capabilities = capabilitiesFrom(new Map([[smtpExtension.size, ""]]), false, "");
    expect(capabilities.maxSize).toBe(0);
  });

  it("supports no authentication mechanisms by default", () => {
    const capabilities = capabilitiesFrom(new Map(), false, "");
    expect(capabilities.auth).toEqual([]);
    expect(capabilities.supportsAuth("PLAIN")).toBe(false);
  });
});
