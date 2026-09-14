import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RawEmail } from "./payload.js";
import { fetchRawEmail, type FetchLike } from "./raw.js";

const rawMessage = "From: sender@example.net\r\nSubject: Hello\r\n\r\nbody\r\n";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Builds a `fetch` that always returns the same response. */
function respondWith(body: string, init?: ResponseInit): FetchLike {
  return async () => new Response(body, init);
}

function rawEmailPayload(
  url: string,
  digest: string | undefined,
  size: number | undefined,
): RawEmail {
  return {
    url,
    token_type: "Bearer",
    access_token: "short-lived-token",
    expires_at_utc: 4102444800,
    size_bytes: size,
    sha256_hex: digest,
  };
}

describe("fetchRawEmail", () => {
  it("downloads and verifies the message", async () => {
    let method: string | undefined;
    let authorization: string | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      method = init?.method;
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(rawMessage, {
        status: 200,
        headers: { "Content-Type": "message/rfc822" },
      });
    };

    const payload = rawEmailPayload(
      "https://raw.example.com/messages/task-1.eml",
      sha256Hex(rawMessage),
      rawMessage.length,
    );
    const body = await fetchRawEmail(payload, { fetch: fetchImpl });

    expect(new TextDecoder().decode(body)).toBe(rawMessage);
    expect(method).toBe("GET");
    expect(authorization).toBe("Bearer short-lived-token");
  });

  it("defaults the authorization scheme to Bearer", async () => {
    let authorization: string | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(rawMessage);
    };

    await fetchRawEmail(
      { url: "https://raw.example.com/messages/task-1.eml", access_token: "short-lived-token" },
      { fetch: fetchImpl },
    );
    expect(authorization).toBe("Bearer short-lived-token");
  });

  it("rejects a digest mismatch", async () => {
    const fetchImpl = respondWith(rawMessage);
    const payload = rawEmailPayload(
      "https://raw.example.com/messages/task-1.eml",
      sha256Hex("something else"),
      rawMessage.length,
    );
    await expect(fetchRawEmail(payload, { fetch: fetchImpl })).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("rejects a size mismatch", async () => {
    const fetchImpl = respondWith(rawMessage);
    const payload = rawEmailPayload(
      "https://raw.example.com/messages/task-1.eml",
      sha256Hex(rawMessage),
      rawMessage.length + 10,
    );
    await expect(fetchRawEmail(payload, { fetch: fetchImpl })).rejects.toThrow(/size/);
  });

  it("rejects an oversized body", async () => {
    const fetchImpl = respondWith(rawMessage);
    const payload = rawEmailPayload("https://raw.example.com/messages/task-1.eml", undefined, 5);
    await expect(fetchRawEmail(payload, { fetch: fetchImpl })).rejects.toThrow(/exceeds/);
  });

  it("reports an unsuccessful status", async () => {
    const fetchImpl = respondWith('{"error":"unauthorized"}', {
      status: 401,
      statusText: "Unauthorized",
    });
    const payload: RawEmail = {
      url: "https://raw.example.com/messages/task-1.eml",
      access_token: "expired",
    };
    await expect(fetchRawEmail(payload, { fetch: fetchImpl })).rejects.toThrow(/401/);
  });

  it("requires a URL and a token", async () => {
    await expect(fetchRawEmail({ url: "", access_token: "token" })).rejects.toThrow(/URL is empty/);
    await expect(
      fetchRawEmail({ url: "https://example.com/messages/x.eml", access_token: "" }),
    ).rejects.toThrow(/access token is empty/);
  });
});
