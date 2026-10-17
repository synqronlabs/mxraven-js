/**
 * Notification client tests against an in-process fake NATS server.
 */

import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeNatsServer, type FakeNatsEvent } from "./__fixtures__/fake-nats.js";
import { NotificationClient } from "./client.js";
import { DecodeError, NotificationError } from "./errors.js";
import { notificationKind } from "./event.js";
import { stopConsuming, type NotificationClientOptions } from "./options.js";

const listener = "listener-1";
const baseUrl = "wss://nats.example";

const acceptedBody = JSON.stringify({
  event_type: "inbound_email",
  task_id: "task-1",
  tenant_id: "tenant-1",
  listener_id: listener,
  attempt: 1,
  accepted_at_utc: 1700000000,
  occurred_at_utc: 1700000001,
  routing_decision: {
    terminal_action: "TERMINAL_ACTION_TYPE_DELIVER_WEBHOOK",
    used_listener_default: false,
  },
  envelope: { mail_from: "sender@example.com", rcpt_to: ["rcpt@example.com"] },
  message: { subject: "hi" },
  headers: [{ name: "Subject", value: "hi" }],
  raw_email: {
    url: "https://raw.example/messages/task-1.eml",
    token_type: "Bearer",
    access_token: "secret-token",
    expires_at_utc: 1700100000,
    size_bytes: 12,
    sha256_hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    content_type: "text/plain",
  },
});

const smtpAttemptBody = JSON.stringify({
  channel: "smtp",
  task_id: "task-1",
  tenant_id: "tenant-1",
  listener_id: listener,
  correlation_id: "accepted-1",
  status: "deferred",
  attempt: 3,
  accepted_at_utc: 1700000000,
  occurred_at_utc: 1700000001,
  smtp_code: 451,
  remote_response: "try later",
});

function event(kind: "accepted" | "attempt", body: string): FakeNatsEvent {
  return { subject: `tenant.tenant-1.listener.${listener}.events.${kind}`, body };
}

const servers: FakeNatsServer[] = [];
const clients: NotificationClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(options?: Parameters<typeof FakeNatsServer.start>[0]) {
  const server = await FakeNatsServer.start(options);
  servers.push(server);
  return server;
}

async function connect(server: FakeNatsServer, overrides: Partial<NotificationClientOptions> = {}) {
  const client = await NotificationClient.connect({
    url: server.url,
    username: "mxr_tx_ab12cd34ef56",
    secret: "api-key-secret",
    listener,
    connectTimeout: 2_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

describe("NotificationClient.connect", () => {
  it("authenticates with the listener API key and derives the consumer", async () => {
    const server = await startServer();
    const client = await connect(server);

    expect(server.connectOptions).toMatchObject({
      user: "mxr_tx_ab12cd34ef56",
      pass: "api-key-secret",
      name: "mxraven-notify",
    });
    await client.close();
  });

  it("rejects when the listener consumer does not exist", async () => {
    const server = await startServer({ consumerNotFound: true });
    await expect(connect(server)).rejects.toBeInstanceOf(NotificationError);
  });

  it.each([
    ["a missing URL", { url: "" }],
    ["a non-WebSocket URL", { url: "https://nats.example" }],
    ["a missing username", { username: "" }],
    ["a missing secret", { secret: "" }],
    ["a missing listener", { listener: "" }],
    ["a listener with a subject wildcard", { listener: "listener.*" }],
    ["a listener with a slash", { listener: "listener/1" }],
    ["a consumer with a dot", { consumer: "notify.listener" }],
    ["a zero connect timeout", { connectTimeout: 0 }],
  ])("rejects %s before connecting", async (_name, overrides) => {
    await expect(
      NotificationClient.connect({
        url: baseUrl,
        username: "mxr_tx_ab12cd34ef56",
        secret: "secret",
        listener,
        ...overrides,
      }),
    ).rejects.toBeInstanceOf(NotificationError);
  });
});

describe("NotificationClient.consume", () => {
  it("decodes and acknowledges an accepted event", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", acceptedBody));
    const client = await connect(server);
    const controller = new AbortController();
    const seen: string[] = [];

    const consuming = client.consume(
      (notification) => {
        seen.push(notification.kind);
      },
      { signal: controller.signal },
    );

    await vi.waitFor(
      () => {
        expect(server.acks.map((ack) => ack.payload)).toContain("+ACK");
      },
      { timeout: 5_000 },
    );
    controller.abort();
    await consuming;
    expect(seen).toEqual([notificationKind.accepted]);
  });

  it("redelivers a failed handler with exponential backoff", async () => {
    const server = await startServer();
    server.enqueue(event("attempt", smtpAttemptBody));
    const client = await connect(server);
    const controller = new AbortController();

    const consuming = client.consume(
      () => {
        throw new Error("transient failure");
      },
      { signal: controller.signal },
    );

    await vi.waitFor(
      () => {
        expect(server.acks.map((ack) => ack.payload)).toContain('-NAK {"delay":1000000000}');
      },
      { timeout: 5_000 },
    );
    controller.abort();
    await consuming;
  });

  it("acknowledges the event and stops when the handler returns stopConsuming", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", acceptedBody));
    const client = await connect(server);
    const seen: string[] = [];

    await client.consume((notification) => {
      seen.push(notification.kind);
      return stopConsuming;
    });

    expect(seen).toEqual([notificationKind.accepted]);
    await vi.waitFor(
      () => {
        expect(server.acks.map((ack) => ack.payload)).toContain("+ACK");
      },
      { timeout: 5_000 },
    );
  });

  it("terminates an undecodable event and rejects", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", "{"));
    const client = await connect(server);

    await expect(client.consume(() => undefined)).rejects.toBeInstanceOf(DecodeError);
    await vi.waitFor(
      () => {
        expect(server.acks.map((ack) => ack.payload)).toContain("+TERM");
      },
      { timeout: 5_000 },
    );
  });

  it("reports an undecodable event and continues when onError is set", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", "{"));
    server.enqueue(event("attempt", smtpAttemptBody));
    const reported: Error[] = [];
    const client = await connect(server, { onError: (error) => reported.push(error) });
    const controller = new AbortController();
    let handled = 0;

    const consuming = client.consume(
      () => {
        handled += 1;
      },
      { signal: controller.signal },
    );

    await vi.waitFor(
      () => {
        expect(handled).toBe(1);
      },
      { timeout: 5_000 },
    );
    expect(reported[0]).toBeInstanceOf(DecodeError);
    expect(server.acks.map((ack) => ack.payload)).toContain("+TERM");
    controller.abort();
    await consuming;
  });

  it("stops cleanly when the caller aborts", async () => {
    const server = await startServer();
    const client = await connect(server);
    const controller = new AbortController();

    const consuming = client.consume(() => undefined, { signal: controller.signal });
    await delay(50);
    controller.abort();
    await expect(consuming).resolves.toBeUndefined();
  });

  it("rejects after the client is closed", async () => {
    const server = await startServer();
    const client = await connect(server);
    await client.close();

    await expect(client.consume(() => undefined)).rejects.toBeInstanceOf(NotificationError);
  });

  it("aborts the handler context when the client closes", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", acceptedBody));
    const client = await connect(server);
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let contextSignal: AbortSignal | undefined;

    const consuming = client.consume((_notification, context) => {
      contextSignal = context.signal;
      started?.();
      return new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    await running;
    await client.close();
    expect(contextSignal?.aborted).toBe(true);
    await consuming;
  });
});

describe("NotificationClient.events", () => {
  it("yields events for manual acknowledgement", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", acceptedBody));
    const client = await connect(server);
    const iterator = client.events();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done) {
      throw new Error("expected an event");
    }
    expect(first.value.event.kind).toBe(notificationKind.accepted);
    first.value.ack();

    await vi.waitFor(
      () => {
        expect(server.acks.map((ack) => ack.payload)).toContain("+ACK");
      },
      { timeout: 5_000 },
    );
    await iterator.close();
  });

  it("supports delayed negative acknowledgement and termination", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", acceptedBody));
    server.enqueue(event("attempt", smtpAttemptBody));
    const client = await connect(server);
    const iterator = client.events();

    const first = await iterator.next();
    if (first.done) {
      throw new Error("expected an event");
    }
    first.value.nak({ delay: 5_000 });

    const second = await iterator.next();
    if (second.done) {
      throw new Error("expected an event");
    }
    second.value.term({ reason: "unusable" });

    await vi.waitFor(
      () => {
        const payloads = server.acks.map((ack) => ack.payload);
        expect(payloads).toContain('-NAK {"delay":5000000000}');
        expect(payloads).toContain("+TERM unusable");
      },
      { timeout: 5_000 },
    );
    await iterator.close();
  });

  it("rejects an undecodable event", async () => {
    const server = await startServer();
    server.enqueue(event("accepted", "{"));
    const client = await connect(server);
    const iterator = client.events();

    await expect(iterator.next()).rejects.toBeInstanceOf(DecodeError);
    await iterator.close();
  });

  it("stops when the client closes", async () => {
    const server = await startServer();
    const client = await connect(server);
    const iterator = client.events();
    const pending = iterator.next();

    await client.close();
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("rejects when used after the client closes", async () => {
    const server = await startServer();
    const client = await connect(server);
    await client.close();

    await expect(client.events().next()).rejects.toBeInstanceOf(NotificationError);
  });

  it("close is idempotent", async () => {
    const server = await startServer();
    const client = await connect(server);
    const iterator = client.events();
    await iterator.close();
    await expect(iterator.close()).resolves.toBeUndefined();
  });
});

describe("NotificationClient.close", () => {
  it("is idempotent", async () => {
    const server = await startServer();
    const client = await connect(server);
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });
});
