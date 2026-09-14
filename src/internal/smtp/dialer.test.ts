import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { parseAddress } from "../address.js";
import { SmtpDialer, type SmtpDialerOptions } from "./dialer.js";
import { MockSmtpServer, type MockSmtpServerOptions } from "./mock-server.js";
import type { SmtpEnvelope } from "./transaction.js";

const tls = {
  key: readFileSync(new URL("./__fixtures__/test-server-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./__fixtures__/test-server-cert.pem", import.meta.url)),
};

const servers: MockSmtpServer[] = [];

async function startServer(options: MockSmtpServerOptions = {}): Promise<MockSmtpServer> {
  const server = await MockSmtpServer.start(options);
  servers.push(server);
  return server;
}

function dialerFor(server: MockSmtpServer, options: Partial<SmtpDialerOptions> = {}): SmtpDialer {
  return new SmtpDialer({
    host: server.host,
    port: server.port,
    connectTimeout: 2_000,
    readTimeout: 2_000,
    writeTimeout: 2_000,
    ...options,
  });
}

function envelope(from: string, recipients: readonly string[]): SmtpEnvelope {
  return {
    from: parseAddress(from),
    recipients: recipients.map((address) => ({ address: parseAddress(address) })),
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("SmtpDialer defaults", () => {
  it("applies documented defaults", () => {
    const dialer = new SmtpDialer({ host: "mail.example.com", port: 465 });
    expect(dialer.host).toBe("mail.example.com");
    expect(dialer.port).toBe(465);
    expect(dialer.localName).toBe("localhost");
    expect(dialer.connectTimeout).toBe(30_000);
    expect(dialer.readTimeout).toBe(300_000);
    expect(dialer.writeTimeout).toBe(300_000);
  });
});

describe("dial", () => {
  it("connects and greets", async () => {
    const server = await startServer({ extensions: ["SIZE 10485760"] });
    const session = await dialerFor(server).dial();
    expect(session.isEsmtp).toBe(true);
    expect(session.hasExtension("SIZE")).toBe(true);
    session.close();
  });

  it("uses the configured local name", async () => {
    const server = await startServer();
    const session = await dialerFor(server, { localName: "my.client.example.com" }).dial();
    expect(server.ehloLine).toBe("EHLO my.client.example.com");
    session.close();
  });

  it("authenticates when credentials are configured", async () => {
    const server = await startServer({ authMechanisms: "PLAIN LOGIN" });
    const session = await dialerFor(server, {
      auth: { username: "user", password: "pass" },
    }).dial();
    expect(session.isAuthenticated).toBe(true);
    session.close();
  });

  it("surfaces connection errors", async () => {
    const dialer = new SmtpDialer({ host: "127.0.0.1", port: 1, connectTimeout: 500 });
    await expect(dialer.dial()).rejects.toBeInstanceOf(Error);
  });

  it("rejects when STARTTLS is required but unsupported", async () => {
    const server = await startServer({ extensions: ["PIPELINING"] });
    await expect(
      dialerFor(server, { startTls: true, requireTls: true }).dial(),
    ).rejects.toMatchObject({ kind: "tls-not-supported" });
  });

  it("upgrades with STARTTLS when supported", async () => {
    const server = await startServer({
      startTls: true,
      tls,
      extensions: ["STARTTLS", "PIPELINING"],
    });
    const session = await dialerFor(server, {
      startTls: true,
      requireTls: true,
      tls: { rejectUnauthorized: false },
    }).dial();
    expect(session.isTls).toBe(true);
    expect(session.hasExtension("PIPELINING")).toBe(true);
    session.close();
  });

  it("connects with implicit TLS", async () => {
    const server = await startServer({ implicitTls: true, tls, extensions: ["PIPELINING"] });
    const session = await dialerFor(server, {
      implicitTls: true,
      tls: { rejectUnauthorized: false },
    }).dial();
    expect(session.isTls).toBe(true);
    session.close();
  });

  it("produces a session ready to send", async () => {
    const server = await startServer({ dataResponseMessage: "2.0.0 Ok: queued as ABC" });
    const session = await dialerFor(server).dial();

    const result = await session.send(
      envelope("sender@example.com", ["recipient@example.com"]),
      new TextEncoder().encode("Subject: Test\r\n\r\nHello"),
    );
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("ABC");
    await session.quit();
  });
});
