import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { SMTPError } from "../../errors.js";
import { parseAddress } from "../address.js";
import { MockSmtpServer, type MockSmtpServerOptions } from "./mock-server.js";
import { SmtpSession, type SmtpSessionOptions } from "./session.js";
import { AUTO_BDAT_THRESHOLD, type SmtpEnvelope } from "./transaction.js";

const tls = {
  key: readFileSync(new URL("./__fixtures__/test-server-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./__fixtures__/test-server-cert.pem", import.meta.url)),
};

const servers: MockSmtpServer[] = [];
const sessions: SmtpSession[] = [];

const encoder = new TextEncoder();

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

function envelope(
  from: string | undefined,
  recipients: readonly string[],
  overrides: Partial<SmtpEnvelope> = {},
): SmtpEnvelope {
  return {
    from: from === undefined ? undefined : parseAddress(from),
    recipients: recipients.map((address) => ({ address: parseAddress(address) })),
    ...overrides,
  };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("send", () => {
  it("completes a transaction and extracts the message reference", async () => {
    const server = await startServer({ dataResponseMessage: "2.0.0 Ok: queued as TEST456" });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const result = await session.send(
      envelope("sender@example.com", ["recipient@example.com"]),
      encoder.encode("Subject: Test\r\n\r\nHello World"),
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("TEST456");
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]?.accepted).toBe(true);
    expect(server.dataLines).toContain("Hello World");
  });

  it("rejects without a connection", async () => {
    const server = await startServer();
    const session = sessionFor(server);
    await expect(
      session.send(envelope("a@example.com", ["b@example.com"]), encoder.encode("data")),
    ).rejects.toMatchObject({ kind: "no-connection" });
  });

  it("rejects without recipients", async () => {
    const server = await startServer();
    const session = sessionFor(server);
    await session.connect();
    await session.hello();
    await expect(
      session.send(envelope("a@example.com", []), encoder.encode("data")),
    ).rejects.toMatchObject({ kind: "no-recipients" });
  });

  it("fails when every recipient is rejected and resets the transaction", async () => {
    const server = await startServer({ rejectRecipients: ["<bad@example.com>"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await expect(
      session.send(envelope("sender@example.com", ["bad@example.com"]), encoder.encode("data")),
    ).rejects.toMatchObject({ kind: "transaction-failed" });
    expect(server.rsetCommands).toBeGreaterThanOrEqual(1);
    expect(server.dataCommands).toBe(0);
  });

  it("succeeds when some recipients are accepted", async () => {
    const server = await startServer({ rejectRecipients: ["<bad@example.com>"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const result = await session.send(
      envelope("sender@example.com", ["good@example.com", "bad@example.com"]),
      encoder.encode("Subject: Test\r\n\r\nHello"),
    );

    expect(result.success).toBe(true);
    const accepted = result.recipients.filter((recipient) => recipient.accepted);
    const rejected = result.recipients.filter((recipient) => !recipient.accepted);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("fails when RequireAllRecipients is set and a recipient is rejected", async () => {
    const server = await startServer({
      extensions: ["PIPELINING"],
      rejectRecipients: ["<bad@example.com>"],
    });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await expect(
      session.send(
        envelope("sender@example.com", ["good@example.com", "bad@example.com"]),
        encoder.encode("Subject: Test\r\n\r\nHello"),
        { requireAllRecipients: true },
      ),
    ).rejects.toMatchObject({ kind: "transaction-failed" });
    expect(server.rsetCommands).toBeGreaterThanOrEqual(1);
  });

  it("uses a single BDAT for a large message when CHUNKING is advertised", async () => {
    const server = await startServer({ extensions: ["CHUNKING"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const data = new Uint8Array(AUTO_BDAT_THRESHOLD + 1).fill(0x78);
    const result = await session.send(envelope("sender@example.com", ["rcpt@example.com"]), data);

    expect(result.success).toBe(true);
    expect(server.bdatCommands).toBe(1);
    expect(server.dataCommands).toBe(0);
  });

  it("uses chunked BDAT when preferred", async () => {
    const server = await startServer({ extensions: ["CHUNKING"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const result = await session.send(
      envelope("sender@example.com", ["rcpt@example.com"]),
      encoder.encode("Subject: BDAT\r\n\r\nHello BDAT"),
      { preferBdat: true, chunkSize: 32 },
    );

    expect(result.success).toBe(true);
    expect(server.bdatCommands).toBeGreaterThan(0);
    expect(server.dataCommands).toBe(0);
  });

  it("uses the default BDAT chunk size when none is given", async () => {
    const server = await startServer({ extensions: ["CHUNKING"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const data = new Uint8Array(64 * 1024 + 10).fill(0x78);
    const result = await session.send(envelope("sender@example.com", ["rcpt@example.com"]), data, {
      preferBdat: true,
    });

    expect(result.success).toBe(true);
    expect(server.bdatCommands).toBe(2);
    expect(server.dataCommands).toBe(0);
    expect(server.bdatChunks.map((chunk) => chunk.length)).toEqual([64 * 1024, 10]);
    expect(server.bdatChunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(data.length);
  });

  it("sends an empty payload as a single terminating BDAT", async () => {
    const server = await startServer({ extensions: ["CHUNKING"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const result = await session.send(
      envelope("sender@example.com", ["rcpt@example.com"]),
      new Uint8Array(),
      { preferBdat: true },
    );

    expect(result.success).toBe(true);
    expect(server.bdatCommands).toBe(1);
    expect(server.dataCommands).toBe(0);
    expect(server.bdatChunks).toHaveLength(0);
  });

  it("uses DATA at exactly the auto-BDAT threshold", async () => {
    const server = await startServer({ extensions: ["CHUNKING"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const data = new Uint8Array(AUTO_BDAT_THRESHOLD).fill(0x78);
    const result = await session.send(envelope("sender@example.com", ["rcpt@example.com"]), data);

    expect(result.success).toBe(true);
    expect(server.dataCommands).toBe(1);
    expect(server.bdatCommands).toBe(0);
  });

  it("adds REQUIRETLS over a TLS session when supported", async () => {
    const server = await startServer({ implicitTls: true, tls, extensions: ["REQUIRETLS"] });
    const session = sessionFor(server, { tls: { rejectUnauthorized: false } });
    await session.connectTls();
    await session.hello();

    await session.send(
      envelope("sender@example.com", ["rcpt@example.com"], { requireTls: true }),
      encoder.encode("Subject: Secure\r\n\r\nHello"),
    );

    expect(server.mailFromLine).toBe("MAIL FROM:<sender@example.com> REQUIRETLS");
  });

  it("rejects REQUIRETLS without TLS", async () => {
    const server = await startServer({ extensions: ["REQUIRETLS"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await expect(
      session.send(
        envelope("sender@example.com", ["rcpt@example.com"], { requireTls: true }),
        encoder.encode("data"),
      ),
    ).rejects.toBeInstanceOf(SMTPError);
  });
});

describe("sendRaw", () => {
  it("streams the payload with dot-stuffing and a trailing CRLF", async () => {
    const server = await startServer({ dataResponseMessage: "2.0.0 Ok: queued as RAW123" });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const raw =
      "From: sender@example.com\r\nTo: rcpt@example.net\r\nSubject: Raw\r\n\r\n.line\r\nbody without final newline";
    const result = await session.sendRaw(
      envelope("sender@example.com", ["rcpt@example.net"]),
      encoder.encode(raw),
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("RAW123");
    expect(server.dataLines).toEqual([
      "From: sender@example.com",
      "To: rcpt@example.net",
      "Subject: Raw",
      "",
      "..line",
      "body without final newline",
    ]);
  });

  it("streams chunked data with dot-stuffing across chunk boundaries", async () => {
    const server = await startServer({ dataResponseMessage: "2.0.0 Ok: queued as SPLIT" });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield encoder.encode("Subject: Split\r\n\r\n.");
      yield encoder.encode("\r\nbody ends with dot");
      yield encoder.encode(".\r\n.");
    }

    const result = await session.sendRaw(
      envelope("sender@example.com", ["rcpt@example.net"]),
      chunks(),
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("SPLIT");
    expect(server.dataLines).toEqual(["Subject: Split", "", "..", "body ends with dot.", ".."]);
  });

  it("advertises SIZE and BODY parameters", async () => {
    const server = await startServer({
      extensions: ["SIZE 102400", "8BITMIME"],
      dataResponseMessage: "2.0.0 Ok: queued as RAW123",
    });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await session.sendRaw(
      envelope("sender@example.com", ["rcpt@example.net"], { size: 128, bodyType: "8BITMIME" }),
      encoder.encode("Subject: Raw\r\n\r\nbody"),
    );

    expect(server.mailFromLine).toBe("MAIL FROM:<sender@example.com> SIZE=128 BODY=8BITMIME");
    expect(server.rcptToLines).toEqual(["RCPT TO:<rcpt@example.net>"]);
  });

  it("adds DSN envelope parameters", async () => {
    const server = await startServer({ extensions: ["DSN"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await session.sendRaw(
      envelope("sender@example.com", ["rcpt@example.net"], {
        dsnRet: "HDRS",
        envid: "env-1",
      }),
      encoder.encode("Subject: DSN\r\n\r\nbody"),
    );

    expect(server.mailFromLine).toContain("RET=HDRS");
    expect(server.mailFromLine).toContain("ENVID=env-1");
  });

  it("adds recipient DSN parameters", async () => {
    const server = await startServer({ extensions: ["DSN"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await session.sendRaw(
      {
        from: parseAddress("sender@example.com"),
        recipients: [
          {
            address: parseAddress("rcpt@example.net"),
            dsnNotify: ["SUCCESS", "FAILURE"],
            dsnOrcpt: "rfc822;orig@example.com",
          },
        ],
      },
      encoder.encode("Subject: DSN\r\n\r\nbody"),
    );

    expect(server.rcptToLines[0]).toBe(
      "RCPT TO:<rcpt@example.net> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;orig@example.com",
    );
  });

  it("formats a DELIVERBY parameter", async () => {
    const server = await startServer({ extensions: ["DELIVERBY 300"] });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await session.sendRaw(
      envelope("sender@example.com", ["rcpt@example.net"], {
        deliveryBy: { seconds: 600, mode: "R" },
      }),
      encoder.encode("Subject: BY\r\n\r\nbody"),
    );

    expect(server.mailFromLine).toBe("MAIL FROM:<sender@example.com> BY=600;R");
  });
});

describe("pipelined envelopes", () => {
  it("writes MAIL FROM and every RCPT TO as one group", async () => {
    const server = await startServer({
      extensions: ["PIPELINING"],
      rejectRecipients: ["<bad@example.com>"],
    });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    const result = await session.send(
      envelope("sender@example.com", ["good@example.com", "bad@example.com"]),
      encoder.encode("Subject: Pipelined\r\n\r\nbody"),
    );

    expect(server.mailFromLine).toBe("MAIL FROM:<sender@example.com>");
    expect(server.rcptToLines).toEqual(["RCPT TO:<good@example.com>", "RCPT TO:<bad@example.com>"]);
    expect(result.recipients.map((recipient) => recipient.accepted)).toEqual([true, false]);
  });

  it("drains every pipelined reply before failing", async () => {
    const server = await startServer({ extensions: ["PIPELINING"], rejectMailFrom: true });
    const session = sessionFor(server);
    await session.connect();
    await session.hello();

    await expect(
      session.send(
        envelope("sender@example.com", ["one@example.com", "two@example.com"]),
        encoder.encode("Subject: Rejected\r\n\r\nbody"),
      ),
    ).rejects.toBeInstanceOf(SMTPError);

    expect(server.rcptToLines).toHaveLength(2);
    await expect(session.noop()).resolves.toBeUndefined();
  });
});
