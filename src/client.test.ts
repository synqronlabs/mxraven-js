import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { Client, type ClientOptions } from "./client.js";
import { SMTPTransactionError } from "./errors.js";
import { MockSmtpServer, type MockSmtpServerOptions } from "./internal/smtp/mock-server.js";
import { Message } from "./message.js";

const tls = {
  key: readFileSync(new URL("./internal/smtp/__fixtures__/test-server-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./internal/smtp/__fixtures__/test-server-cert.pem", import.meta.url)),
};

const defaultExtensions = ["STARTTLS", "PIPELINING", "SIZE 26214400", "SMTPUTF8"];

const servers: MockSmtpServer[] = [];
const clients: Client[] = [];

const encoder = new TextEncoder();

async function startServer(options: MockSmtpServerOptions = {}): Promise<MockSmtpServer> {
  const server = await MockSmtpServer.start({
    startTls: true,
    tls,
    extensions: defaultExtensions,
    authMechanisms: "PLAIN LOGIN",
    ...options,
  });
  servers.push(server);
  return server;
}

function clientFor(server: MockSmtpServer, overrides: Partial<ClientOptions> = {}): Client {
  const client = new Client({
    host: server.host,
    port: server.port,
    username: "mxr_tx_test",
    secret: "secret",
    tls: { rejectUnauthorized: false },
    connectTimeout: 2_000,
    readTimeout: 2_000,
    writeTimeout: 2_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

function message(from: string, to: string): Message {
  return new Message().from(from).to(to).subject("Test").text("Hello");
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Client options", () => {
  it.each([
    [{ host: "", username: "u", secret: "s" }, /host/],
    [{ host: "smtp.example.com", port: 0, username: "u", secret: "s" }, /port/],
    [{ host: "smtp.example.com", port: 70000, username: "u", secret: "s" }, /port/],
    [{ host: "smtp.example.com", username: "", secret: "s" }, /username/],
    [{ host: "smtp.example.com", username: "u", secret: "" }, /secret/],
    [{ host: "smtp.example.com", username: "u", secret: "s", poolSize: 0 }, /pool size/],
  ])("rejects invalid options %#", (options, pattern) => {
    expect(() => new Client(options as ClientOptions)).toThrow(pattern);
  });
});

describe("Client.send", () => {
  it("submits a message and returns the server result", async () => {
    const server = await startServer({
      dataResponseMessage: "2.0.0 accepted; message_ref=<abc-123>",
    });
    const client = clientFor(server);

    const result = await client.send(
      message("Acme <noreply@acme.example>", "customer@example.com"),
    );

    expect(result.messageRef).toBe("abc-123");
    expect(result.code).toBe(250);
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]?.address).toBe("customer@example.com");
    expect(result.recipients[0]?.accepted).toBe(true);
    expect(server.dataLines).toContain("Hello");
  });

  it("uses a null reverse-path for a null sender", async () => {
    const server = await startServer();
    const client = clientFor(server);

    await client.send(
      new Message()
        .from("Bounce <bounce@acme.example>")
        .to("customer@example.com")
        .nullSender()
        .text("Bounce"),
    );

    expect(server.mailFromLine?.startsWith("MAIL FROM:<>")).toBe(true);
  });

  it("advertises SIZE and SMTPUTF8 for an internationalized message", async () => {
    const server = await startServer();
    const client = clientFor(server);

    await client.send(message("üser@acme.example", "customer@example.com"));

    expect(server.mailFromLine).toContain("SIZE=");
    expect(server.mailFromLine).toContain("SMTPUTF8");
  });

  it("sends concurrently through separate pooled connections", async () => {
    const server = await startServer();
    const client = clientFor(server, { poolSize: 5 });

    const results = await Promise.all([
      client.send(message("sender@acme.example", "one@example.com")),
      client.send(message("sender@acme.example", "two@example.com")),
    ]);

    expect(results.every((result) => result.code === 250)).toBe(true);
    expect(server.connections).toBe(2);
  });

  it("throws an SMTPTransactionError carrying per-recipient detail", async () => {
    const server = await startServer({ rejectRecipients: ["<bad@example.com>"] });
    const client = clientFor(server);

    const error = await client
      .send(message("sender@acme.example", "bad@example.com"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SMTPTransactionError);
    const transaction = error as SMTPTransactionError;
    expect(transaction.result.recipients[0]?.accepted).toBe(false);
    expect(transaction.result.recipients[0]?.error).toBeDefined();
  });

  it("rejects when closed", async () => {
    const server = await startServer();
    const client = clientFor(server);
    await client.close();
    await expect(
      client.send(message("sender@acme.example", "customer@example.com")),
    ).rejects.toThrow(/closed/);
  });

  it("surfaces connection failures", async () => {
    const client = new Client({
      host: "127.0.0.1",
      port: 1,
      username: "u",
      secret: "s",
      connectTimeout: 500,
    });
    clients.push(client);
    await expect(
      client.send(message("sender@acme.example", "customer@example.com")),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a non-message argument", async () => {
    const server = await startServer();
    const client = clientFor(server);
    await expect(client.send({} as Message)).rejects.toThrow(/message is required/);
  });
});

describe("Client.sendRaw", () => {
  it("streams raw bytes with an explicit envelope", async () => {
    const server = await startServer({ dataResponseMessage: "2.0.0 Ok: queued as RAW1" });
    const client = clientFor(server);

    const result = await client.sendRaw(
      { from: "sender@example.com", to: ["rcpt@example.net"] },
      encoder.encode("Subject: Raw\r\n\r\n.body"),
    );

    expect(result.code).toBe(250);
    expect(result.messageRef).toBe("");
    expect(result.recipients[0]?.accepted).toBe(true);
    expect(server.dataLines).toContain("..body");
  });

  it("rejects an invalid envelope address", async () => {
    const server = await startServer();
    const client = clientFor(server);

    await expect(
      client.sendRaw({ from: "not an address", to: ["rcpt@example.net"] }, encoder.encode("data")),
    ).rejects.toThrow(/invalid/);
  });

  it("rejects an envelope without recipients", async () => {
    const server = await startServer();
    const client = clientFor(server);

    await expect(
      client.sendRaw({ from: "sender@example.com", to: [] }, encoder.encode("data")),
    ).rejects.toThrow(/no recipients/i);
  });
});

describe("Client.close", () => {
  it("is idempotent", async () => {
    const server = await startServer();
    const client = clientFor(server);
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });
});
