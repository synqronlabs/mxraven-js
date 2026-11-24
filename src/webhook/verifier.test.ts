import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  InvalidSignatureError,
  PayloadTooLargeError,
  Verifier,
  WebhookRequestError,
  webhookHeaders,
  type WebhookRequestParts,
} from "./index.js";

const testSecret = "whsec_dGVzdHNlY3JldA";
const testKid = "whk_test";

const body = `{"from":"sender@example.net","verdict":"allow"}`;

/** Reproduces the mxRaven signing algorithm independently of the package. */
function sign(
  secret: string,
  method: string,
  url: URL,
  timestamp: string,
  webhookId: string,
  payload: string,
): string {
  const bodyHash = createHash("sha256").update(payload).digest("hex");
  const canonical = [
    timestamp,
    webhookId,
    method,
    url.host.toLowerCase(),
    url.pathname === "" ? "/" : url.pathname + url.search,
    bodyHash,
  ].join("\n");
  return `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

interface RequestParts {
  readonly secret: string;
  readonly body: string;
  readonly timestamp: string;
  readonly url?: string;
  readonly method?: string;
  readonly webhookId?: string;
  readonly kid?: string | null;
  readonly signature?: string | null;
}

function buildRequest(parts: RequestParts): Request {
  const url = parts.url ?? "https://hooks.example.com/mxraven?tenant=acme";
  const method = parts.method ?? "POST";
  const webhookId = parts.webhookId ?? "task-123";
  const headers: Record<string, string> = {
    [webhookHeaders.webhookId]: webhookId,
    [webhookHeaders.timestamp]: parts.timestamp,
  };
  if (parts.signature !== null) {
    headers[webhookHeaders.signature] =
      parts.signature ??
      sign(parts.secret, method, new URL(url), parts.timestamp, webhookId, parts.body);
  }
  if (parts.kid !== null) {
    headers[webhookHeaders.signatureKid] = parts.kid ?? testKid;
  }
  return new Request(url, { method, headers, body: parts.body });
}

/** Builds framework request primitives from the same inputs. */
function buildParts(parts: RequestParts): WebhookRequestParts {
  const request = buildRequest(parts);
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: new TextEncoder().encode(parts.body),
  };
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("Verifier", () => {
  it("verifies a signed request", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({ secret: testSecret, body, timestamp: nowSeconds() });

    await expect(verifier.verify(request)).resolves.toBeUndefined();
  });

  it("leaves the original request body readable", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({ secret: testSecret, body, timestamp: nowSeconds() });

    await verifier.verify(request);
    expect(await request.text()).toBe(body);
  });

  it("verifies framework request parts", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const parts = buildParts({ secret: testSecret, body, timestamp: nowSeconds() });

    await expect(verifier.verify(parts)).resolves.toBeUndefined();
  });

  it("enforces the body limit for framework request parts", async () => {
    const verifier = new Verifier({ secret: testSecret, maxBodyBytes: 16 });
    const parts = buildParts({ secret: testSecret, body, timestamp: nowSeconds() });

    await expect(verifier.verify(parts)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("rejects invalid framework request parts", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const parts = buildParts({ secret: testSecret, body, timestamp: nowSeconds() });

    await expect(verifier.verify({ ...parts, url: "not a url" })).rejects.toBeInstanceOf(
      WebhookRequestError,
    );
  });

  it("exposes the listener and revision header names", () => {
    expect(webhookHeaders.listener).toBe("X-MxRaven-Listener");
    expect(webhookHeaders.revision).toBe("X-MxRaven-Revision");
  });

  it("does not bind the unsigned listener and revision headers", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({ secret: testSecret, body, timestamp: nowSeconds() });
    request.headers.set(webhookHeaders.listener, "listener-1");
    request.headers.set(webhookHeaders.revision, "revision-1");

    await expect(verifier.verify(request)).resolves.toBeUndefined();

    // Neither header is part of the canonical string, so changing them after
    // signing must not invalidate the signature.
    request.headers.set(webhookHeaders.listener, "another-listener");
    request.headers.set(webhookHeaders.revision, "another-revision");
    await expect(verifier.verify(request)).resolves.toBeUndefined();
  });

  it("rejects a tampered body", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({ secret: testSecret, body, timestamp: nowSeconds() });
    const tampered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: `${body} `,
    });

    await expect(verifier.verify(tampered)).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects a wrong secret", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({
      secret: "whsec_other",
      body,
      timestamp: nowSeconds(),
    });
    await expect(verifier.verify(request)).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it.each([[webhookHeaders.webhookId], [webhookHeaders.timestamp], [webhookHeaders.signature]])(
    "rejects a request missing %s",
    async (header) => {
      const verifier = new Verifier({ secret: testSecret });
      const request = buildRequest({ secret: testSecret, body, timestamp: nowSeconds() });
      request.headers.delete(header);
      await expect(verifier.verify(request)).rejects.toThrow(/webhook:/);
    },
  );

  it("enforces the timestamp tolerance and can disable it", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const request = buildRequest({ secret: testSecret, body, timestamp });

    const strict = new Verifier({ secret: testSecret });
    await expect(strict.verify(request.clone())).rejects.toThrow(/clock skew/);

    const relaxed = new Verifier({ secret: testSecret, tolerance: 0 });
    await expect(relaxed.verify(request)).resolves.toBeUndefined();
  });

  it("supports per-key secrets", async () => {
    const verifier = new Verifier({ keys: new Map([[testKid, testSecret]]) });
    await expect(
      verifier.verify(buildRequest({ secret: testSecret, body, timestamp: nowSeconds() })),
    ).resolves.toBeUndefined();

    const unknown = new Verifier({ keys: new Map([["whk_other", testSecret]]) });
    await expect(
      unknown.verify(buildRequest({ secret: testSecret, body, timestamp: nowSeconds() })),
    ).rejects.toThrow(/unknown signature key ID/);

    await expect(
      verifier.verify(
        buildRequest({ secret: testSecret, body, timestamp: nowSeconds(), kid: null }),
      ),
    ).rejects.toThrow(/missing signature key ID/);
  });

  it("enforces the body size limit", async () => {
    const verifier = new Verifier({ secret: testSecret, maxBodyBytes: 16 });
    await expect(
      verifier.verify(buildRequest({ secret: testSecret, body, timestamp: nowSeconds() })),
    ).rejects.toThrow(/exceeds/);
  });

  it("rejects an unsupported signature scheme", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({
      secret: testSecret,
      body,
      timestamp: nowSeconds(),
      signature: "sha1=deadbeef",
    });
    await expect(verifier.verify(request)).rejects.toThrow(/unsupported/);
  });

  it("binds the signature to the request target", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const signed = buildRequest({ secret: testSecret, body, timestamp: nowSeconds() });
    const different = new Request("https://hooks.example.com/different", {
      method: "POST",
      headers: signed.headers,
      body,
    });
    await expect(verifier.verify(different)).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("requires a secret", () => {
    expect(() => new Verifier()).toThrow(/signing secret is required/);
    expect(() => new Verifier({ secret: "" })).toThrow(/signing secret is required/);
  });

  it.each([
    [{ keys: new Map([["", testSecret]]) }, /key ID/],
    [{ keys: new Map([[testKid, ""]]) }, /signing secret/],
    [{ secret: testSecret, tolerance: -1000 }, /tolerance/],
    [{ secret: testSecret, maxBodyBytes: 0 }, /body size/],
  ])("rejects invalid options %#", (options, pattern) => {
    expect(() => new Verifier(options)).toThrow(pattern);
  });
});
