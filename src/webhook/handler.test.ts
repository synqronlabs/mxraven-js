import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WebhookHandler,
  eventType,
  webhookHeaders,
  type DeliveryStatus,
  type InboundEmail,
  type StorageStatus,
} from "./index.js";

const SECRET = "whsec_dGVzdHNlY3JldA";
const URL_STRING = "https://hooks.example.com/mxraven?tenant=acme";

const encoder = new TextEncoder();

const inboundPayload = encoder.encode(
  JSON.stringify({
    event_type: "inbound_email",
    task_id: "task-123",
    tenant_id: "tenant-1",
    listener_id: "listener-1",
    attempt: 1,
    accepted_at_utc: 1789302600,
    occurred_at_utc: 1789302601,
    routing_decision: {
      terminal_action: "TERMINAL_ACTION_TYPE_RELAY",
      used_listener_default: false,
    },
    envelope: { mail_from: "sender@example.net", rcpt_to: ["support@example.com"] },
    message: { subject: "Hello" },
    headers: [{ name: "From", value: "sender@example.net" }],
    raw_email: {
      url: "https://raw.example.com/messages/task-123.eml",
      token_type: "Bearer",
      access_token: "token",
    },
  }),
);

const deliveryPayload = encoder.encode(JSON.stringify({ status: "delivered", task_id: "task-9" }));

const storagePayload = encoder.encode(
  JSON.stringify({ event_type: "s3_egress_status", task_id: "task-3", status: "delivered" }),
);

/** The current Unix time in seconds. */
function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Reproduces the mxRaven signing algorithm independently of the package. */
function sign(body: Uint8Array, timestamp: string, webhookId: string, secret = SECRET): string {
  const url = new URL(URL_STRING);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [
    timestamp,
    webhookId,
    "POST",
    url.host.toLowerCase(),
    url.pathname + url.search,
    bodyHash,
  ].join("\n");
  return `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

interface SignedRequestOptions {
  readonly body: Uint8Array;
  readonly secret?: string;
  readonly signature?: string | null;
  readonly timestamp?: string;
  readonly webhookId?: string;
}

/** Builds a signed Fetch request, or an unsigned one when `signature` is `null`. */
function signedRequest(options: SignedRequestOptions): Request {
  const timestamp = options.timestamp ?? nowSeconds();
  const webhookId = options.webhookId ?? "task-123";
  const headers: Record<string, string> = {
    [webhookHeaders.timestamp]: timestamp,
    [webhookHeaders.webhookId]: webhookId,
  };
  if (options.signature !== null) {
    headers[webhookHeaders.signature] =
      options.signature ?? sign(options.body, timestamp, webhookId, options.secret);
  }
  return new Request(URL_STRING, { method: "POST", headers, body: options.body });
}

describe("WebhookHandler", () => {
  it("dispatches an inbound-email event and acknowledges it", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    const seen: InboundEmail[] = [];
    handler.on(eventType.inboundEmail, (email) => {
      seen.push(email);
    });

    const response = await handler.handle(signedRequest({ body: inboundPayload }));

    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.task_id).toBe("task-123");
  });

  it("dispatches delivery and storage statuses through their own listeners", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    const deliveries: DeliveryStatus[] = [];
    const storages: StorageStatus[] = [];
    handler.on(eventType.deliveryStatus, (status) => {
      deliveries.push(status);
    });
    handler.on(eventType.storageStatus, (status) => {
      storages.push(status);
    });

    expect((await handler.handle(signedRequest({ body: deliveryPayload }))).status).toBe(204);
    expect((await handler.handle(signedRequest({ body: storagePayload }))).status).toBe(204);
    expect(deliveries[0]?.task_id).toBe("task-9");
    expect(storages[0]?.task_id).toBe("task-3");
  });

  it("rejects a bad signature with 401 without dispatching", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    let called = false;
    handler.on(eventType.inboundEmail, () => {
      called = true;
    });

    const response = await handler.handle(
      signedRequest({ body: inboundPayload, signature: `sha256=${"00".repeat(32)}` }),
    );

    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });

  it("rejects a missing signature with 400", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    const response = await handler.handle(signedRequest({ body: inboundPayload, signature: null }));

    expect(response.status).toBe(400);
  });

  it("rejects a malformed payload with 400", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    const response = await handler.handle(signedRequest({ body: encoder.encode("not json") }));

    expect(response.status).toBe(400);
  });

  it("rejects an oversized body with 413", async () => {
    const handler = new WebhookHandler({ secret: SECRET, maxBodyBytes: 16 });
    const response = await handler.handle(signedRequest({ body: inboundPayload }));

    expect(response.status).toBe(413);
  });

  it("responds 500 when a listener throws", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    handler.on(eventType.inboundEmail, () => {
      throw new Error("boom");
    });

    const response = await handler.handle(signedRequest({ body: inboundPayload }));

    expect(response.status).toBe(500);
  });

  it("runs listeners in registration order", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    const order: string[] = [];
    handler.on(eventType.inboundEmail, async () => {
      order.push("first");
    });
    handler.on(eventType.inboundEmail, () => {
      order.push("second");
    });

    await handler.handle(signedRequest({ body: inboundPayload }));

    expect(order).toEqual(["first", "second"]);
  });

  it("adapts framework primitives through handle", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    const seen: InboundEmail[] = [];
    handler.on("inbound_email", (email) => {
      seen.push(email);
    });

    const timestamp = nowSeconds();
    const response = await handler.handle({
      method: "POST",
      url: URL_STRING,
      headers: {
        [webhookHeaders.webhookId]: "task-123",
        [webhookHeaders.timestamp]: timestamp,
        [webhookHeaders.signature]: sign(inboundPayload, timestamp, "task-123"),
      },
      body: inboundPayload,
    });

    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
  });

  it("rejects an oversized primitive body with 413", async () => {
    const handler = new WebhookHandler({ secret: SECRET, maxBodyBytes: 16 });
    const response = await handler.handle({
      method: "POST",
      url: URL_STRING,
      headers: {},
      body: inboundPayload,
    });

    expect(response.status).toBe(413);
  });

  it("returns 400 for an invalid URL through handle", async () => {
    const handler = new WebhookHandler({ secret: SECRET });
    const response = await handler.handle({
      method: "POST",
      url: "not a url",
      headers: {},
      body: inboundPayload,
    });

    expect(response.status).toBe(400);
  });
});
