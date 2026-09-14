import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  InvalidSignatureError,
  Verifier,
  decode,
  eventType,
  terminalAction,
  webhookHeaders,
  type DeliveryStatus,
  type Event,
  type InboundEmail,
  type StorageStatus,
} from "./index.js";

const testSecret = "whsec_dGVzdHNlY3JldA";
const testKid = "whk_test";

function expectInbound(event: Event): InboundEmail {
  if (event.type !== eventType.inboundEmail) {
    throw new Error(`expected inbound_email, got ${event.type}`);
  }
  return event.inboundEmail;
}

function expectDelivery(event: Event): DeliveryStatus {
  if (event.type !== eventType.deliveryStatus) {
    throw new Error(`expected delivery_status, got ${event.type}`);
  }
  return event.deliveryStatus;
}

function expectStorage(event: Event): StorageStatus {
  if (event.type !== eventType.storageStatus) {
    throw new Error(`expected s3_egress_status, got ${event.type}`);
  }
  return event.storageStatus;
}

const inboundBody = `{
	"event_type": "inbound_email",
	"task_id": "task-123",
	"tenant_id": "tenant-1",
	"listener_id": "listener-1",
	"attempt": 1,
	"accepted_at_utc": 1789302600,
	"occurred_at_utc": 1789302601,
	"routing_decision": {"terminal_action": "TERMINAL_ACTION_TYPE_RELAY", "used_listener_default": false},
	"envelope": {"mail_from": "sender@example.net", "rcpt_to": ["support@example.com"]},
	"message": {"subject": "Hello"},
	"headers": [{"name": "From", "value": "sender@example.net"}],
	"raw_email": {"url": "https://raw.example.com/messages/task-123.eml", "token_type": "Bearer", "access_token": "token"}
}`;

/** Reproduces the mxRaven signing algorithm independently of the package. */
function sign(
  secret: string,
  method: string,
  url: URL,
  timestamp: string,
  webhookId: string,
  body: string,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
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

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("Verifier", () => {
  it("verifies and decodes an inbound email", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const event = await verifier.verifyAndDecode(
      buildRequest({ secret: testSecret, body: inboundBody, timestamp: nowSeconds() }),
    );

    const inbound = expectInbound(event);
    expect(inbound.task_id).toBe("task-123");
    expect(inbound.routing_decision.terminal_action).toBe(terminalAction.relay);
  });

  it("leaves the original request body readable", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({
      secret: testSecret,
      body: inboundBody,
      timestamp: nowSeconds(),
    });

    await verifier.verify(request);
    expect(await request.text()).toBe(inboundBody);
  });

  it("rejects a tampered body", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({
      secret: testSecret,
      body: inboundBody,
      timestamp: nowSeconds(),
    });
    const tampered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: `${inboundBody} `,
    });

    await expect(verifier.verify(tampered)).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects a wrong secret", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({
      secret: "whsec_other",
      body: inboundBody,
      timestamp: nowSeconds(),
    });
    await expect(verifier.verify(request)).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it.each([[webhookHeaders.webhookId], [webhookHeaders.timestamp], [webhookHeaders.signature]])(
    "rejects a request missing %s",
    async (header) => {
      const verifier = new Verifier({ secret: testSecret });
      const request = buildRequest({
        secret: testSecret,
        body: inboundBody,
        timestamp: nowSeconds(),
      });
      request.headers.delete(header);
      await expect(verifier.verify(request)).rejects.toThrow(/webhook:/);
    },
  );

  it("enforces the timestamp tolerance and can disable it", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const request = buildRequest({ secret: testSecret, body: inboundBody, timestamp });

    const strict = new Verifier({ secret: testSecret });
    await expect(strict.verify(request.clone())).rejects.toThrow(/clock skew/);

    const relaxed = new Verifier({ secret: testSecret, tolerance: 0 });
    await expect(relaxed.verify(request)).resolves.toBeUndefined();
  });

  it("supports per-key secrets", async () => {
    const verifier = new Verifier({ keys: new Map([[testKid, testSecret]]) });
    await expect(
      verifier.verify(
        buildRequest({ secret: testSecret, body: inboundBody, timestamp: nowSeconds() }),
      ),
    ).resolves.toBeUndefined();

    const unknown = new Verifier({ keys: new Map([["whk_other", testSecret]]) });
    await expect(
      unknown.verify(
        buildRequest({ secret: testSecret, body: inboundBody, timestamp: nowSeconds() }),
      ),
    ).rejects.toThrow(/unknown signature key ID/);

    await expect(
      verifier.verify(
        buildRequest({ secret: testSecret, body: inboundBody, timestamp: nowSeconds(), kid: null }),
      ),
    ).rejects.toThrow(/missing signature key ID/);
  });

  it("enforces the body size limit", async () => {
    const verifier = new Verifier({ secret: testSecret, maxBodyBytes: 16 });
    await expect(
      verifier.verify(
        buildRequest({ secret: testSecret, body: inboundBody, timestamp: nowSeconds() }),
      ),
    ).rejects.toThrow(/exceeds/);
  });

  it("rejects an unsupported signature scheme", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const request = buildRequest({
      secret: testSecret,
      body: inboundBody,
      timestamp: nowSeconds(),
      signature: "sha1=deadbeef",
    });
    await expect(verifier.verify(request)).rejects.toThrow(/unsupported/);
  });

  it("binds the signature to the request target", async () => {
    const verifier = new Verifier({ secret: testSecret });
    const signed = buildRequest({ secret: testSecret, body: inboundBody, timestamp: nowSeconds() });
    const different = new Request("https://hooks.example.com/different", {
      method: "POST",
      headers: signed.headers,
      body: inboundBody,
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

describe("decode", () => {
  it("decodes an inbound email", () => {
    const inbound = expectInbound(decode(inboundBody));
    expect(inbound.envelope.mail_from).toBe("sender@example.net");
    expect(inbound.headers[0]?.name).toBe("From");
    expect(inbound.raw_email.access_token).toBe("token");
  });

  it("decodes an SMTP delivery status without an event type", () => {
    const delivery = expectDelivery(
      decode(
        `{"task_id":"task-1","status":"deferred","attempt":2,"accepted_at_utc":1,"occurred_at_utc":2,"smtp_code":451}`,
      ),
    );
    expect(delivery.status).toBe("deferred");
    expect(delivery.smtp_code).toBe(451);
  });

  it("decodes an object-storage status", () => {
    const storage = expectStorage(
      decode(
        `{"event_type":"s3_egress_status","status":"delivered","attempt":1,"occurred_at_utc":1,"object_key":"2026/09/task-1.eml"}`,
      ),
    );
    expect(storage.object_key).toBe("2026/09/task-1.eml");
  });

  it.each([["{"], ['{"event_type":"something_else"}'], [""]])("rejects %j", (body) => {
    expect(() => decode(body)).toThrow(/webhook:/);
  });
});
