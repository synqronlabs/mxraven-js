import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RawEmail } from "../webhook/payload.js";
import type { FetchLike } from "../webhook/raw.js";
import { fetchAndParseRawEmail } from "./index.js";

const MESSAGE = "Subject: Inbound\r\nContent-Type: text/plain\r\n\r\nhello";

/** Builds a valid `raw_email` payload for the given bytes. */
function rawEmailFor(bytes: Uint8Array, overrides: Partial<RawEmail> = {}): RawEmail {
  return {
    url: "https://raw.example.com/message.eml",
    access_token: "token",
    size_bytes: bytes.byteLength,
    sha256_hex: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
}

describe("fetchAndParseRawEmail", () => {
  it("downloads, verifies, and parses in one call", async () => {
    const bytes = new TextEncoder().encode(MESSAGE);
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(bytes, { status: 200 });
    };

    const email = await fetchAndParseRawEmail(rawEmailFor(bytes), { fetch: fetcher });
    expect(email.subject).toBe("Inbound");
    expect(email.text).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://raw.example.com/message.eml");
    expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer token" });
  });

  it("propagates digest verification failures", async () => {
    const bytes = new TextEncoder().encode(MESSAGE);
    const fetcher: FetchLike = async () => new Response(bytes, { status: 200 });

    await expect(
      fetchAndParseRawEmail(rawEmailFor(bytes, { sha256_hex: "0".repeat(64) }), {
        fetch: fetcher,
      }),
    ).rejects.toThrow(/SHA-256/);
  });
});
