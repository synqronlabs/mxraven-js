import { afterEach, describe, expect, it } from "vitest";

import { parseAddress } from "../address.js";
import { SmtpDialer } from "./dialer.js";
import { SmtpAbortError } from "./errors.js";
import { MockSmtpServer, type MockSmtpServerOptions } from "./mock-server.js";
import { SmtpPool, type SmtpPoolOptions } from "./pool.js";
import { SmtpSession } from "./session.js";
import type { SmtpEnvelope } from "./transaction.js";

const servers: MockSmtpServer[] = [];
const pools: SmtpPool[] = [];

async function startServer(options: MockSmtpServerOptions = {}): Promise<MockSmtpServer> {
  const server = await MockSmtpServer.start(options);
  servers.push(server);
  return server;
}

function poolFor(server: MockSmtpServer, options: Partial<SmtpPoolOptions> = {}): SmtpPool {
  const pool = new SmtpPool({
    dialer: new SmtpDialer({
      host: server.host,
      port: server.port,
      connectTimeout: 2_000,
      readTimeout: 2_000,
      writeTimeout: 2_000,
    }),
    ...options,
  });
  pools.push(pool);
  return pool;
}

function envelope(from: string, recipients: readonly string[]): SmtpEnvelope {
  return {
    from: parseAddress(from),
    recipients: recipients.map((address) => ({ address: parseAddress(address) })),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const data = new TextEncoder().encode("Subject: Test\r\n\r\nbody");

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    await pool.close();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("SmtpPool sizing", () => {
  it("defaults to 5 for zero, negative, and missing sizes", async () => {
    const server = await startServer();
    expect(poolFor(server).size).toBe(5);
    expect(poolFor(server, { size: 0 }).size).toBe(5);
    expect(poolFor(server, { size: -1 }).size).toBe(5);
  });

  it("honors a custom size", async () => {
    const server = await startServer();
    expect(poolFor(server, { size: 10 }).size).toBe(10);
  });
});

describe("SmtpPool lifecycle", () => {
  it("closes idempotently", async () => {
    const server = await startServer();
    const pool = poolFor(server);
    await pool.close();
    await pool.close();
    expect(pool.isClosed).toBe(true);
  });

  it("rejects acquires after close", async () => {
    const server = await startServer();
    const pool = poolFor(server);
    await pool.close();
    await expect(pool.acquire()).rejects.toMatchObject({ kind: "client-closed" });
  });

  it("closes a foreign session on release", async () => {
    const server = await startServer();
    const pool = poolFor(server);
    const foreign = new SmtpSession({ host: server.host, port: server.port });
    expect(() => pool.release(foreign)).not.toThrow();
    expect(pool.isClosed).toBe(false);
  });

  it("rejects callers waiting for capacity when closed", async () => {
    const server = await startServer();
    const pool = poolFor(server, { size: 1 });
    const first = await pool.acquire();
    const pending = pool.acquire();

    await pool.close();
    await expect(pending).rejects.toMatchObject({ kind: "client-closed" });
    pool.release(first);
  });

  it("releases capacity when a dial fails", async () => {
    const dialer = new SmtpDialer({ host: "127.0.0.1", port: 1, connectTimeout: 500 });
    const pool = new SmtpPool({ dialer, size: 1 });
    pools.push(pool);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await pool
        .acquire(AbortSignal.timeout(2_000))
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SmtpAbortError);
    }
  });

  it("closes sessions released while closing", async () => {
    const server = await startServer();
    const pool = poolFor(server, { size: 4 });
    const first = await pool.acquire();
    const second = await pool.acquire();

    await Promise.all([
      pool.close(),
      Promise.resolve().then(() => pool.release(first)),
      Promise.resolve().then(() => pool.release(second)),
    ]);

    expect(pool.isClosed).toBe(true);
    await expect(first.noop()).rejects.toMatchObject({ kind: "no-connection" });
    await expect(second.noop()).rejects.toMatchObject({ kind: "no-connection" });
  });
});

describe("SmtpPool reuse", () => {
  it("reuses an idle session", async () => {
    const server = await startServer();
    const pool = poolFor(server);

    const first = await pool.acquire();
    pool.release(first);
    const second = await pool.acquire();

    expect(second).toBe(first);
    expect(server.connections).toBe(1);
    pool.release(second);
  });

  it("discards a stale idle session", async () => {
    const server = await startServer();
    const pool = poolFor(server);

    const first = await pool.acquire();
    pool.release(first);
    first.close();

    const second = await pool.acquire();
    expect(second).not.toBe(first);
    expect(server.connections).toBe(2);
    pool.release(second);
  });

  it("bounds the number of live connections", async () => {
    const server = await startServer();
    const pool = poolFor(server, { size: 1 });

    const first = await pool.acquire();
    let second: SmtpSession | undefined;
    const pending = pool.acquire().then((session) => {
      second = session;
      return session;
    });

    await delay(20);
    expect(second).toBeUndefined();

    pool.release(first);
    const acquired = await pending;
    expect(acquired).toBe(first);
    expect(server.connections).toBe(1);
    pool.release(acquired);
  });
});

describe("SmtpPool send", () => {
  it("sends and reuses the connection", async () => {
    const server = await startServer({ dataResponseMessage: "2.0.0 Ok: queued as A" });
    const pool = poolFor(server);

    await pool.send(envelope("sender@example.com", ["one@example.com"]), data);
    await pool.send(envelope("sender@example.com", ["two@example.com"]), data);

    expect(server.connections).toBe(1);
  });

  it("discards the session when a transaction fails", async () => {
    const server = await startServer({ rejectRecipients: ["<bad@example.com>"] });
    const pool = poolFor(server);

    await expect(
      pool.send(envelope("sender@example.com", ["bad@example.com"]), data),
    ).rejects.toMatchObject({ kind: "transaction-failed" });

    await pool.send(envelope("sender@example.com", ["good@example.com"]), data);
    expect(server.connections).toBe(2);
  });
});
