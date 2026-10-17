/**
 * An in-process NATS WebSocket server for notification tests.
 *
 * It implements the subset of the NATS protocol and JetStream API the
 * notification client uses: the INFO/CONNECT handshake, subscriptions,
 * request-reply, one pull consumer, and message acknowledgment. It is
 * intentionally not a general-purpose NATS server.
 *
 * @internal
 */

import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

/** One event the fake server can deliver. */
export interface FakeNatsEvent {
  /** The subject the event was published to. */
  readonly subject: string;
  /** The JSON body. */
  readonly body: string;
}

/** A payload the client published to an acknowledgement subject. */
export interface FakeAck {
  /** The full acknowledgement subject. */
  readonly subject: string;
  /** The acknowledgement payload, for example `+ACK` or `-NAK`. */
  readonly payload: string;
}

/** Options for {@link FakeNatsServer}. */
export interface FakeNatsServerOptions {
  /** The durable consumer name the server reports. Defaults to `notify-listener-1`. */
  readonly consumer?: string;
  /** The stream name. Defaults to `CLIENT_NOTIFY`. */
  readonly stream?: string;
  /** Reports a missing consumer instead of a consumer description. */
  readonly consumerNotFound?: boolean;
}

interface Subscription {
  readonly sid: string;
  readonly subject: string;
}

interface PendingPull {
  readonly reply: string;
  readonly sid: string;
}

/** A minimal NATS-over-WebSocket server. */
export class FakeNatsServer {
  private readonly options: Required<FakeNatsServerOptions>;
  private readonly server: WebSocketServer;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly pulls: PendingPull[] = [];
  private readonly events: FakeNatsEvent[] = [];
  private readonly acknowledgements: FakeAck[] = [];
  private socket: WebSocket | undefined;
  private buffer = Buffer.alloc(0);
  private delivery = 0;

  /** The parsed CONNECT payload, once the client has sent it. */
  connectOptions: Record<string, unknown> | undefined;

  private constructor(options: Required<FakeNatsServerOptions>, server: WebSocketServer) {
    this.options = options;
    this.server = server;
    server.on("connection", (socket) => this.accept(socket));
  }

  /** Starts the server on an ephemeral loopback port. */
  static async start(options: FakeNatsServerOptions = {}): Promise<FakeNatsServer> {
    const resolved: Required<FakeNatsServerOptions> = {
      consumer: options.consumer ?? "notify-listener-1",
      stream: options.stream ?? "CLIENT_NOTIFY",
      consumerNotFound: options.consumerNotFound ?? false,
    };
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    return new FakeNatsServer(resolved, server);
  }

  /** The `ws://` URL a client connects to. */
  get url(): string {
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}`;
  }

  /** Every acknowledgement payload the client published. */
  get acks(): readonly FakeAck[] {
    return this.acknowledgements;
  }

  /** Queues one event for the next pull request. */
  enqueue(event: FakeNatsEvent): void {
    this.events.push(event);
    this.flush();
  }

  /** Closes the server and every connection. */
  async close(): Promise<void> {
    for (const client of this.server.clients) {
      client.close();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private accept(socket: WebSocket): void {
    this.socket = socket;
    this.send(`INFO ${JSON.stringify(this.serverInfo())}\r\n`);
    socket.on("message", (data) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(data as ArrayBuffer)]);
      this.parse();
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
    });
  }

  private serverInfo(): Record<string, unknown> {
    return {
      server_id: "fake",
      server_name: "fake",
      version: "2.11.0",
      proto: 1,
      go: "go1.26",
      host: "127.0.0.1",
      port: 0,
      headers: true,
      max_payload: 1 << 20,
      jetstream: true,
    };
  }

  private parse(): void {
    for (;;) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd < 0) {
        return;
      }
      const line = this.buffer.subarray(0, lineEnd).toString("utf8");
      if (line.startsWith("PUB ") || line.startsWith("HPUB ")) {
        const consumed = this.parsePublish(line, lineEnd);
        if (consumed === undefined) {
          return;
        }
        continue;
      }
      this.buffer = this.buffer.subarray(lineEnd + 2);
      this.handleControl(line);
    }
  }

  private parsePublish(line: string, lineEnd: number): number | undefined {
    const parts = line.split(/\s+/u);
    const isHeaders = parts[0] === "HPUB";
    const subject = parts[1] ?? "";
    let reply: string | undefined;
    let total = 0;

    if (isHeaders) {
      total = Number(parts.at(-1) ?? Number.NaN);
    } else if (parts.length === 3) {
      total = Number(parts[2]);
    } else if (parts.length === 4) {
      reply = parts[2];
      total = Number(parts[3]);
    }
    if (!Number.isInteger(total) || total < 0) {
      return undefined;
    }

    const start = lineEnd + 2;
    const end = start + total;
    if (this.buffer.length < end + 2) {
      return undefined;
    }
    const payload = this.buffer.subarray(start, end).toString("utf8");
    this.buffer = this.buffer.subarray(end + 2);
    this.handlePublish(subject, reply, payload);
    return end + 2;
  }

  private handleControl(line: string): void {
    const parts = line.split(/\s+/u);
    switch (parts[0]) {
      case "CONNECT":
        this.connectOptions = JSON.parse(line.slice("CONNECT ".length)) as Record<string, unknown>;
        return;
      case "PING":
        this.send("PONG\r\n");
        return;
      case "SUB": {
        const subject = parts[1] ?? "";
        const sid = parts.at(-1) ?? "";
        this.subscriptions.set(sid, { sid, subject });
        return;
      }
      case "UNSUB": {
        const sid = parts[1] ?? "";
        this.subscriptions.delete(sid);
        return;
      }
      default:
        return;
    }
  }

  private handlePublish(subject: string, reply: string | undefined, payload: string): void {
    if (subject.startsWith("$JS.API.CONSUMER.INFO.")) {
      this.respondConsumerInfo(reply);
      return;
    }
    if (subject.startsWith("$JS.API.CONSUMER.MSG.NEXT.")) {
      if (reply !== undefined) {
        this.pulls.push({ reply, sid: this.findSid(reply) });
        this.flush();
      }
      return;
    }
    if (subject.startsWith("$JS.ACK.")) {
      this.acknowledgements.push({ subject, payload });
    }
  }

  private respondConsumerInfo(reply: string | undefined): void {
    if (reply === undefined) {
      return;
    }
    const sid = this.findSid(reply);
    if (sid === "") {
      return;
    }

    if (this.options.consumerNotFound) {
      this.deliverToInbox(reply, sid, {
        error: { code: 404, description: "consumer not found" },
        type: "io.nats.jetstream.api.v1.consumer_info_response",
      });
      return;
    }

    this.deliverToInbox(reply, sid, {
      type: "io.nats.jetstream.api.v1.consumer_info_response",
      stream_name: this.options.stream,
      name: this.options.consumer,
      created: "2026-01-01T00:00:00Z",
      config: {
        durable_name: this.options.consumer,
        name: this.options.consumer,
        filter_subject: "tenant.tenant-1.listener.listener-1.events.>",
        deliver_policy: "all",
        ack_policy: "explicit",
        replay_policy: "instant",
        ack_wait: 30_000_000_000,
        max_ack_pending: 256,
        max_deliver: -1,
      },
      delivered: { consumer_seq: 0, stream_seq: 0 },
      ack_floor: { consumer_seq: 0, stream_seq: 0 },
      num_ack_pending: 0,
      num_redelivered: 0,
      num_waiting: 0,
      num_pending: 0,
    });
  }

  private flush(): void {
    while (this.pulls.length > 0 && this.events.length > 0) {
      const pull = this.pulls.shift();
      const event = this.events.shift();
      if (pull === undefined || event === undefined) {
        return;
      }
      if (!this.subscriptions.has(pull.sid)) {
        continue;
      }
      this.delivery += 1;
      const ack = `$JS.ACK.${this.options.stream}.${this.options.consumer}.${this.delivery}.${this.delivery}.${this.delivery}.0.0`;
      const body = Buffer.from(event.body, "utf8");
      this.send(
        `MSG ${event.subject} ${pull.sid} ${ack} ${body.byteLength}\r\n${body.toString("utf8")}\r\n`,
      );
    }
  }

  private deliverToInbox(reply: string, sid: string, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    this.send(`MSG ${reply} ${sid} ${body.byteLength}\r\n${body.toString("utf8")}\r\n`);
  }

  private findSid(subject: string): string {
    let wildcard = "";
    for (const subscription of this.subscriptions.values()) {
      if (subscription.subject === subject) {
        return subscription.sid;
      }
      if (wildcard === "" && matches(subscription.subject, subject)) {
        wildcard = subscription.sid;
      }
    }
    return wildcard;
  }

  private send(data: string): void {
    if (this.socket?.readyState === 1) {
      this.socket.send(Buffer.from(data, "utf8"), { binary: true });
    }
  }
}

/** Reports whether a NATS subject matches a subscription pattern. */
function matches(pattern: string, subject: string): boolean {
  const wanted = pattern.split(".");
  const actual = subject.split(".");
  for (let index = 0; index < wanted.length; index++) {
    const token = wanted[index];
    if (token === ">") {
      return true;
    }
    if (token !== "*" && token !== actual[index]) {
      return false;
    }
  }
  return wanted.length === actual.length;
}
