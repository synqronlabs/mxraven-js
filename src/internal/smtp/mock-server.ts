/**
 * An in-process SMTP server for tests.
 *
 * It supports the subset of SMTP the session exercises: EHLO/HELO, AUTH
 * PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT, STARTTLS, and
 * implicit TLS. It is intentionally not a general-purpose server.
 *
 * @internal
 */

import { once } from "node:events";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  createSecureContext,
  createServer as createTlsServer,
  TLSSocket,
  type SecureContext,
} from "node:tls";

/** TLS material for a mock server that speaks TLS. */
export interface MockTlsOptions {
  /** The PEM-encoded private key. */
  readonly key: Buffer | string;
  /** The PEM-encoded certificate. */
  readonly cert: Buffer | string;
}

/** Configuration for a {@link MockSmtpServer}. */
export interface MockSmtpServerOptions {
  /** The greeting line sent on connect. */
  readonly greeting?: string;
  /** Extensions advertised in the EHLO reply. */
  readonly extensions?: readonly string[];
  /** Mechanisms appended as an `AUTH` extension, for example `PLAIN LOGIN`. */
  readonly authMechanisms?: string;
  /** Rejects AUTH with a 535 reply. */
  readonly rejectAuth?: boolean;
  /** Rejects `MAIL FROM` with a 550 reply. */
  readonly rejectMailFrom?: boolean;
  /** Rejects these envelope recipients with a 550 reply. */
  readonly rejectRecipients?: readonly string[];
  /** Rejects EHLO with a 502 reply so the client falls back to HELO. */
  readonly rejectEhlo?: boolean;
  /** The final DATA reply code. Defaults to 250. */
  readonly dataResponseCode?: number;
  /** The final DATA reply text. */
  readonly dataResponseMessage?: string;
  /** Enables the STARTTLS command. Requires {@link MockSmtpServerOptions.tls}. */
  readonly startTls?: boolean;
  /** Accepts TLS immediately, before any command. Requires `tls`. */
  readonly implicitTls?: boolean;
  /** TLS material used by STARTTLS or implicit TLS. */
  readonly tls?: MockTlsOptions;
  /** Accepts connections but never sends a greeting or replies. */
  readonly silent?: boolean;
}

/** A line-oriented reader over a duplex stream. */
class LineReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly lineWaiters: Array<(line: string | null) => void> = [];
  private readonly byteWaiters: Array<{ size: number; resolve: (bytes: Buffer | null) => void }> =
    [];
  private ended = false;

  constructor(private readonly stream: Duplex) {
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.on("close", this.onEnd);
    stream.on("error", this.onEnd);
  }

  /** Removes the underlying stream listeners. */
  detach(): void {
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onEnd);
    this.stream.off("error", this.onEnd);
  }

  /** Reads one line, or resolves `null` at end of stream. */
  readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      this.lineWaiters.push(resolve);
      this.drain();
    });
  }

  /** Reads exactly `size` bytes, or fewer at end of stream. */
  readBytes(size: number): Promise<Buffer | null> {
    if (this.buffer.length >= size) {
      const bytes = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      return Promise.resolve(bytes);
    }
    if (this.ended) {
      const bytes = this.buffer;
      this.buffer = Buffer.alloc(0);
      return Promise.resolve(bytes.length > 0 ? bytes : null);
    }
    return new Promise((resolve) => {
      this.byteWaiters.push({ size, resolve });
    });
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.flushEnd();
  };

  private drain(): void {
    while (this.byteWaiters.length > 0) {
      const waiter = this.byteWaiters[0];
      if (waiter === undefined || this.buffer.length < waiter.size) {
        break;
      }
      this.byteWaiters.shift();
      waiter.resolve(this.buffer.subarray(0, waiter.size));
      this.buffer = this.buffer.subarray(waiter.size);
    }

    while (this.lineWaiters.length > 0) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) {
        return;
      }
      const line = this.buffer.subarray(0, index + 1).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      this.lineWaiters.shift()?.(line);
    }
  }

  private flushEnd(): void {
    for (const waiter of this.byteWaiters.splice(0)) {
      const bytes = this.buffer.subarray(0, Math.min(waiter.size, this.buffer.length));
      this.buffer = this.buffer.subarray(bytes.length);
      waiter.resolve(bytes.length > 0 || waiter.size === 0 ? bytes : null);
    }
    if (this.buffer.length > 0 && this.lineWaiters.length > 0) {
      const line = this.buffer.toString("utf8");
      this.buffer = Buffer.alloc(0);
      this.lineWaiters.shift()?.(line);
    }
    while (this.lineWaiters.length > 0) {
      this.lineWaiters.shift()?.(null);
    }
  }
}

/** One accepted mock connection. */
interface MockConnection {
  readonly reader: LineReader;
  write(line: string): void;
  upgradeTls(): Promise<MockConnection>;
}

/** A configurable in-process SMTP server. */
export class MockSmtpServer {
  private server!: NetServer;
  private readonly options: MockSmtpServerOptions;
  private readonly secureContext: SecureContext | undefined;
  private readonly sockets = new Set<Duplex>();

  /** Counts accepted connections. */
  connections = 0;

  /** Records the most recent `EHLO` command. */
  ehloLine: string | undefined;

  /** Records the most recent `MAIL FROM` command. */
  mailFromLine: string | undefined;

  /** Records every `RCPT TO` command. */
  readonly rcptToLines: string[] = [];

  /** Counts `DATA` commands. */
  dataCommands = 0;

  /** Counts `BDAT` commands. */
  bdatCommands = 0;

  /** Counts `RSET` commands. */
  rsetCommands = 0;

  /** Records every DATA line, without line terminators. */
  readonly dataLines: string[] = [];

  /** Records the payload of every BDAT chunk. */
  readonly bdatChunks: Buffer[] = [];

  private constructor(options: MockSmtpServerOptions) {
    this.options = options;
    this.secureContext =
      options.tls === undefined
        ? undefined
        : createSecureContext({ key: options.tls.key, cert: options.tls.cert });
  }

  /** Starts a mock server on an ephemeral loopback port. */
  static async start(options: MockSmtpServerOptions = {}): Promise<MockSmtpServer> {
    const instance = new MockSmtpServer(options);
    if (options.implicitTls === true && options.tls !== undefined) {
      instance.server = createTlsServer(
        { key: options.tls.key, cert: options.tls.cert },
        (socket) => instance.accept(socket),
      );
    } else {
      instance.server = createNetServer((socket) => instance.accept(socket));
    }
    await new Promise<void>((resolve, reject) => {
      instance.server.once("error", reject);
      instance.server.listen(0, "127.0.0.1", () => resolve());
    });
    return instance;
  }

  /** The listening port. */
  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("mock smtp server is not listening on a TCP port");
    }
    return address.port;
  }

  /** The listening host. */
  get host(): string {
    return "127.0.0.1";
  }

  /** The `host:port` address. */
  get address(): string {
    return `${this.host}:${this.port}`;
  }

  /** Stops the server and destroys open connections. */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private accept(socket: Duplex): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    void this.handle(this.makeConnection(socket));
  }

  private makeConnection(socket: Duplex): MockConnection {
    const reader = new LineReader(socket);
    return {
      reader,
      write: (line) => {
        socket.write(`${line}\r\n`);
      },
      upgradeTls: async () => {
        if (this.secureContext === undefined) {
          throw new Error("mock smtp server has no TLS context");
        }
        reader.detach();
        const secure = new TLSSocket(socket as Socket, {
          isServer: true,
          secureContext: this.secureContext,
        });
        this.sockets.add(secure);
        secure.on("close", () => this.sockets.delete(secure));
        await once(secure, "secure");
        return this.makeConnection(secure);
      },
    };
  }

  private async handle(connection: MockConnection, greet = true): Promise<void> {
    if (this.options.silent === true) {
      return new Promise<void>(() => {
        // Keep the connection open without replying.
      });
    }

    if (greet) {
      connection.write(this.options.greeting ?? "220 mock.example.com ESMTP");
    }

    for (;;) {
      const line = await connection.reader.readLine();
      if (line === null) {
        return;
      }
      const command = line.replace(/\r?\n$/, "");
      const upper = command.toUpperCase();

      if (upper.startsWith("EHLO")) {
        this.ehloLine = command;
        if (this.options.rejectEhlo === true) {
          connection.write("502 5.5.1 Not supported");
          continue;
        }
        const extensions = [...(this.options.extensions ?? [])];
        if (this.options.authMechanisms !== undefined && this.options.authMechanisms !== "") {
          extensions.push(`AUTH ${this.options.authMechanisms}`);
        }
        this.writeEhlo(connection, extensions);
      } else if (upper.startsWith("HELO")) {
        connection.write("250 mock.example.com");
      } else if (upper.startsWith("MAIL FROM:")) {
        this.mailFromLine = command;
        if (this.options.rejectMailFrom === true) {
          connection.write("550 5.1.0 Sender rejected");
        } else {
          connection.write("250 2.1.0 Ok");
        }
      } else if (upper.startsWith("RCPT TO:")) {
        this.rcptToLines.push(command);
        const recipient = command.slice("RCPT TO:".length).trim();
        if (this.options.rejectRecipients?.includes(recipient) === true) {
          connection.write("550 5.1.1 User unknown");
        } else {
          connection.write("250 2.1.5 Ok");
        }
      } else if (upper === "DATA") {
        this.dataCommands += 1;
        connection.write("354 Start mail input");
        for (;;) {
          const dataLine = await connection.reader.readLine();
          if (dataLine === null) {
            return;
          }
          const text = dataLine.replace(/\r?\n$/, "");
          if (text === ".") {
            break;
          }
          this.dataLines.push(text);
        }
        const code = this.options.dataResponseCode ?? 250;
        const message = this.options.dataResponseMessage ?? "2.0.0 Ok: queued as MOCK123";
        connection.write(`${code} ${message}`);
      } else if (upper === "BDAT" || upper.startsWith("BDAT ")) {
        this.bdatCommands += 1;
        const size = Number.parseInt(command.split(/\s+/)[1] ?? "0", 10);
        if (Number.isFinite(size) && size > 0) {
          const bytes = await connection.reader.readBytes(size);
          if (bytes !== null) {
            this.bdatChunks.push(bytes);
          }
        }
        connection.write("250 2.0.0 Ok");
      } else if (upper === "RSET") {
        this.rsetCommands += 1;
        connection.write("250 2.0.0 Ok");
      } else if (upper === "NOOP") {
        connection.write("250 2.0.0 Ok");
      } else if (upper === "QUIT") {
        connection.write("221 2.0.0 Bye");
        return;
      } else if (upper.startsWith("AUTH PLAIN")) {
        connection.write(
          this.options.rejectAuth === true
            ? "535 5.7.8 Authentication failed"
            : "235 2.7.0 Authentication successful",
        );
      } else if (upper === "AUTH LOGIN") {
        if (this.options.rejectAuth === true) {
          connection.write("535 5.7.8 Authentication failed");
          continue;
        }
        connection.write("334 VXNlcm5hbWU6");
        await connection.reader.readLine();
        connection.write("334 UGFzc3dvcmQ6");
        await connection.reader.readLine();
        connection.write("235 2.7.0 Authentication successful");
      } else if (upper === "STARTTLS") {
        if (this.options.startTls !== true || this.secureContext === undefined) {
          connection.write("502 5.5.1 Not supported");
          continue;
        }
        connection.write("220 2.0.0 Ready for TLS");
        const secure = await connection.upgradeTls();
        return this.handle(secure, false);
      } else {
        connection.write("502 5.5.1 Command not recognized");
      }
    }
  }

  private writeEhlo(connection: MockConnection, extensions: readonly string[]): void {
    if (extensions.length === 0) {
      connection.write("250 mock.example.com");
      return;
    }
    connection.write("250-mock.example.com");
    extensions.forEach((extension, index) => {
      const separator = index === extensions.length - 1 ? " " : "-";
      connection.write(`250${separator}${extension}`);
    });
  }
}
