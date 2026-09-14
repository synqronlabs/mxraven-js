import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { SMTPError } from "../../errors.js";
import { SmtpAbortError, SmtpSessionError, SmtpTimeoutError } from "./errors.js";
import { MockSmtpServer, type MockSmtpServerOptions } from "./mock-server.js";
import { SmtpSession, type SmtpSessionOptions } from "./session.js";

const tls = {
  key: readFileSync(new URL("./__fixtures__/test-server-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./__fixtures__/test-server-cert.pem", import.meta.url)),
};

const servers: MockSmtpServer[] = [];
const sessions: SmtpSession[] = [];

async function startServer(options: MockSmtpServerOptions = {}): Promise<MockSmtpServer> {
  const server = await MockSmtpServer.start(options);
  servers.push(server);
  return server;
}

function sessionFor(
  server: MockSmtpServer,
  options: Partial<SmtpSessionOptions> = {},
): SmtpSession {
  const session = new SmtpSession({
    host: server.host,
    port: server.port,
    connectTimeout: 2_000,
    readTimeout: 2_000,
    writeTimeout: 2_000,
    ...options,
  });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("connect and EHLO", () => {
  it("connects, reads the greeting, and parses extensions", async () => {
    const server = await startServer({
      extensions: ["SIZE 10485760", "PIPELINING", "8BITMIME", "ENHANCEDSTATUSCODES"],
    });
    const session = sessionFor(server);

    await session.connect();
    expect(session.greeting).toContain("mock.example.com");
    expect(session.serverName).toBe("127.0.0.1");

    await session.hello();
    expect(session.isEsmtp).toBe(true);
    expect(session.hasExtension("PIPELINING")).toBe(true);
    expect(session.hasExtension("STARTTLS")).toBe(false);
    expect(session.getExtensionParam("SIZE")).toBe("10485760");
    expect(session.maxSize()).toBe(10485760);
  });

  it("rejects a non-success greeting", async () => {
    const server = await startServer({ greeting: "421 Service unavailable" });
    const session = sessionFor(server);
    await expect(session.connect()).rejects.toBeInstanceOf(SMTPError);
  });

  it("falls back to HELO when EHLO is rejected", async () => {
    const server = await startServer({ rejectEhlo: true });
    const session = sessionFor(server);

    await session.connect();
    await session.hello();
    expect(session.isEsmtp).toBe(false);
    expect(session.hasExtension("PIPELINING")).toBe(false);
  });

  it("returns a copy of the extensions", async () => {
    const server = await startServer({ extensions: ["PIPELINING"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const snapshot = session.extensionsSnapshot() as Map<string, string>;
    snapshot.set("STARTTLS", "");
    expect(session.hasExtension("STARTTLS")).toBe(false);
  });

  it("rejects when no connection has been established", async () => {
    const server = await startServer();
    const session = sessionFor(server);
    await expect(session.hello()).rejects.toMatchObject({ kind: "no-connection" });
  });

  it("rejects once the client has been closed", async () => {
    const server = await startServer();
    const session = sessionFor(server);
    await session.connect();
    session.close();
    await expect(session.connect()).rejects.toMatchObject({ kind: "client-closed" });
  });

  it("reports connect failures", async () => {
    const session = new SmtpSession({ host: "127.0.0.1", port: 1, connectTimeout: 500 });
    sessions.push(session);
    await expect(session.connect()).rejects.toBeInstanceOf(Error);
  });

  it("times out reading the greeting", async () => {
    const server = await startServer({ silent: true });
    const session = sessionFor(server, { readTimeout: 50 });
    await expect(session.connect()).rejects.toBeInstanceOf(SmtpTimeoutError);
  });

  it("honors an already-aborted signal", async () => {
    const server = await startServer();
    const session = sessionFor(server);
    const controller = new AbortController();
    controller.abort();
    await expect(session.connect(controller.signal)).rejects.toBeInstanceOf(SmtpAbortError);
  });

  it("reports exchanged commands and replies when debugging", async () => {
    const server = await startServer({ extensions: ["PIPELINING"] });
    const lines: string[] = [];
    const session = sessionFor(server, {
      debug: (direction, line) => lines.push(`${direction}:${line}`),
    });

    await session.connect();
    await session.hello();
    expect(lines.some((line) => line.startsWith("client:EHLO"))).toBe(true);
    expect(lines.some((line) => line.startsWith("server:250"))).toBe(true);
  });
});

describe("authentication", () => {
  it("authenticates with AUTH PLAIN", async () => {
    const server = await startServer({ authMechanisms: "PLAIN LOGIN" });
    const session = sessionFor(server, { auth: { username: "user", password: "pass" } });

    await session.connect();
    await session.hello();
    await session.auth();
    expect(session.isAuthenticated).toBe(true);
  });

  it("authenticates with AUTH LOGIN", async () => {
    const server = await startServer({ authMechanisms: "LOGIN" });
    const session = sessionFor(server, { auth: { username: "user", password: "pass" } });

    await session.connect();
    await session.hello();
    await session.auth();
    expect(session.isAuthenticated).toBe(true);
  });

  it("rejects when the server refuses authentication", async () => {
    const server = await startServer({ authMechanisms: "PLAIN LOGIN", rejectAuth: true });
    const session = sessionFor(server, { auth: { username: "user", password: "wrong" } });

    await session.connect();
    await session.hello();
    await expect(session.auth()).rejects.toMatchObject({ kind: "auth-failed" });
  });

  it("rejects when no credentials are configured", async () => {
    const server = await startServer({ authMechanisms: "PLAIN LOGIN" });
    const session = sessionFor(server);

    await session.connect();
    await session.hello();
    await expect(session.auth()).rejects.toMatchObject({ kind: "no-credentials" });
  });

  it("rejects when there is no connection", async () => {
    const server = await startServer();
    const session = sessionFor(server, { auth: { username: "u", password: "p" } });
    await expect(session.auth()).rejects.toMatchObject({ kind: "no-connection" });
  });

  it("rejects when AUTH is not advertised", async () => {
    const server = await startServer({ extensions: ["PIPELINING"] });
    const session = sessionFor(server, { auth: { username: "u", password: "p" } });

    await session.connect();
    await session.hello();
    await expect(session.auth()).rejects.toMatchObject({ kind: "extension-not-supported" });
  });

  it("rejects when no mechanism is supported", async () => {
    const server = await startServer({ extensions: ["AUTH XOAUTH2 CRAM-MD5"] });
    const session = sessionFor(server, { auth: { username: "u", password: "p" } });

    await session.connect();
    await session.hello();
    await expect(session.auth()).rejects.toMatchObject({ kind: "auth-failed" });
  });

  it("authenticates with an explicit mechanism", async () => {
    const server = await startServer({ authMechanisms: "PLAIN LOGIN" });
    const session = sessionFor(server, { auth: { username: "user", password: "pass" } });

    await session.connect();
    await session.hello();
    await session.authWithMechanism("PLAIN");
    expect(session.isAuthenticated).toBe(true);
  });

  it("rejects an unsupported explicit mechanism", async () => {
    const server = await startServer({ authMechanisms: "PLAIN LOGIN" });
    const session = sessionFor(server, { auth: { username: "u", password: "p" } });

    await session.connect();
    await session.hello();
    await expect(session.authWithMechanism("GSSAPI")).rejects.toThrow(/unsupported/);
  });

  it("rejects an explicit mechanism without connection or credentials", async () => {
    const server = await startServer();
    const noConnection = sessionFor(server, { auth: { username: "u", password: "p" } });
    await expect(noConnection.authWithMechanism("PLAIN")).rejects.toMatchObject({
      kind: "no-connection",
    });

    const noCredentials = sessionFor(server);
    await noCredentials.connect();
    await noCredentials.hello();
    await expect(noCredentials.authWithMechanism("PLAIN")).rejects.toMatchObject({
      kind: "no-credentials",
    });
  });
});

describe("stateless commands", () => {
  it("runs RSET, NOOP, and QUIT", async () => {
    const server = await startServer();
    const session = sessionFor(server);

    await session.connect();
    await session.hello();
    await session.reset();
    await session.noop();
    await session.quit();

    await expect(session.noop()).rejects.toMatchObject({ kind: "no-connection" });
  });

  it("closes idempotently", async () => {
    const server = await startServer();
    const session = sessionFor(server);
    await session.connect();
    session.close();
    session.close();
    await expect(session.noop()).rejects.toMatchObject({ kind: "no-connection" });
  });

  it("rejects RSET, NOOP, and QUIT without a connection", async () => {
    const session = new SmtpSession({ host: "127.0.0.1", port: 1 });
    sessions.push(session);
    await expect(session.reset()).rejects.toMatchObject({ kind: "no-connection" });
    await expect(session.noop()).rejects.toMatchObject({ kind: "no-connection" });
    await expect(session.quit()).rejects.toMatchObject({ kind: "no-connection" });
  });
});

describe("STARTTLS", () => {
  it("rejects when the server does not advertise STARTTLS", async () => {
    const server = await startServer({ extensions: ["PIPELINING"] });
    const session = sessionFor(server);

    await session.connect();
    await session.hello();
    await expect(session.startTls()).rejects.toMatchObject({ kind: "tls-not-supported" });
  });

  it("rejects when TLS is already active", async () => {
    const server = await startServer({ implicitTls: true, tls, extensions: [] });
    const session = sessionFor(server, { tls: { rejectUnauthorized: false } });

    await session.connectTls();
    await expect(session.startTls()).rejects.toMatchObject({ kind: "tls-already-active" });
  });

  it("rejects without a connection", async () => {
    const session = new SmtpSession({ host: "127.0.0.1", port: 1 });
    sessions.push(session);
    await expect(session.startTls()).rejects.toMatchObject({ kind: "no-connection" });
  });

  it("upgrades the connection and allows a fresh EHLO", async () => {
    const server = await startServer({
      startTls: true,
      tls,
      extensions: ["STARTTLS", "PIPELINING"],
    });
    const session = sessionFor(server, { tls: { rejectUnauthorized: false } });

    await session.connect();
    await session.hello();
    expect(session.hasExtension("STARTTLS")).toBe(true);

    await session.startTls();
    expect(session.isTls).toBe(true);

    await session.hello();
    expect(session.isEsmtp).toBe(true);
    expect(session.hasExtension("PIPELINING")).toBe(true);
  });

  it("connects with implicit TLS", async () => {
    const server = await startServer({ implicitTls: true, tls, extensions: ["PIPELINING"] });
    const session = sessionFor(server, { tls: { rejectUnauthorized: false } });

    await session.connectTls();
    expect(session.isTls).toBe(true);
    await session.hello();
    expect(session.hasExtension("PIPELINING")).toBe(true);
  });
});

describe("session errors", () => {
  it("exposes a stable kind", () => {
    const error = new SmtpSessionError("no-connection", "smtp: no connection established");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SmtpSessionError");
    expect(error.kind).toBe("no-connection");
  });
});
