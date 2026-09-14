import { describe, expect, it } from "vitest";

import { SMTPError } from "../../errors.js";
import { SmtpSessionError } from "./errors.js";
import {
  buildMailFromCommand,
  buildRcptToCommand,
  dotStuff,
  extractMessageId,
  type CommandContext,
  type SmtpEnvelope,
} from "./transaction.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function context(extensions: readonly string[], isTls = false): CommandContext {
  const map = new Map<string, string>();
  for (const extension of extensions) {
    const index = extension.indexOf(" ");
    const name = index === -1 ? extension : extension.slice(0, index);
    map.set(name.toUpperCase(), index === -1 ? "" : extension.slice(index + 1));
  }
  return {
    isTls,
    hasExtension: (name) => map.has(name.toUpperCase()),
    getExtensionParam: (name) => map.get(name.toUpperCase()) ?? "",
  };
}

function envelope(overrides: Partial<SmtpEnvelope> = {}): SmtpEnvelope {
  return {
    from: { localPart: "sender", domain: "example.com" },
    recipients: [{ address: { localPart: "rcpt", domain: "example.net" } }],
    ...overrides,
  };
}

function capture(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("buildMailFromCommand", () => {
  it("uses a null reverse-path when the sender is absent", () => {
    expect(buildMailFromCommand(context([]), envelope({ from: undefined }))).toBe("MAIL FROM:<>");
  });

  it("includes SIZE, BODY, and SMTPUTF8 when advertised", () => {
    const command = buildMailFromCommand(
      context(["SIZE 102400", "8BITMIME", "SMTPUTF8"]),
      envelope({ size: 128, bodyType: "8BITMIME", smtpUtf8: true }),
    );
    expect(command).toBe("MAIL FROM:<sender@example.com> SIZE=128 BODY=8BITMIME SMTPUTF8");
  });

  it("omits BODY when the server does not advertise it", () => {
    const command = buildMailFromCommand(
      context(["SIZE 102400"]),
      envelope({ size: 128, bodyType: "8BITMIME", smtpUtf8: true }),
    );
    expect(command).toBe("MAIL FROM:<sender@example.com> SIZE=128");
  });

  it("rejects REQUIRETLS without an active TLS session", () => {
    const error = capture(() =>
      buildMailFromCommand(context(["REQUIRETLS"]), envelope({ requireTls: true })),
    );
    expect(error).toBeInstanceOf(SMTPError);
    expect((error as SMTPError).code).toBe(550);
    expect((error as SMTPError).enhancedCode).toBe("5.7.30");
  });

  it("rejects REQUIRETLS when the server does not support it", () => {
    expect(() => buildMailFromCommand(context([], true), envelope({ requireTls: true }))).toThrow(
      /REQUIRETLS support required/,
    );
  });

  it("adds REQUIRETLS over TLS when supported", () => {
    const command = buildMailFromCommand(
      context(["REQUIRETLS"], true),
      envelope({ requireTls: true }),
    );
    expect(command).toBe("MAIL FROM:<sender@example.com> REQUIRETLS");
  });

  it("rejects DELIVERBY when the server does not support it", () => {
    const error = capture(() =>
      buildMailFromCommand(context([]), envelope({ deliveryBy: { seconds: 600, mode: "R" } })),
    );
    expect(error).toBeInstanceOf(SmtpSessionError);
    expect((error as SmtpSessionError).kind).toBe("delivery-by-not-supported");
  });

  it("formats a valid DELIVERBY parameter", () => {
    const command = buildMailFromCommand(
      context(["DELIVERBY 300"]),
      envelope({ deliveryBy: { seconds: 600, mode: "R" } }),
    );
    expect(command).toBe("MAIL FROM:<sender@example.com> BY=600;R");
  });

  it("rejects a DELIVERBY value below the server minimum", () => {
    expect(() =>
      buildMailFromCommand(
        context(["DELIVERBY 300"]),
        envelope({ deliveryBy: { seconds: 100, mode: "R" } }),
      ),
    ).toThrow(/below server minimum/);
  });

  it("supports tracing and notify mode", () => {
    const command = buildMailFromCommand(
      context(["DELIVERBY 0"]),
      envelope({ deliveryBy: { seconds: 0, mode: "N", trace: true } }),
    );
    expect(command).toBe("MAIL FROM:<sender@example.com> BY=0;NT");
  });

  it("adds AUTH and DSN envelope parameters", () => {
    const command = buildMailFromCommand(
      context(["DSN"]),
      envelope({ auth: "identity", dsnRet: "hdrs", envid: "env 1" }),
    );
    expect(command).toBe("MAIL FROM:<sender@example.com> AUTH=<identity> RET=HDRS ENVID=env+201");
  });

  it("adds custom extension parameters", () => {
    const command = buildMailFromCommand(
      context([]),
      envelope({
        extensionParams: new Map([
          ["x-trace", "1"],
          ["noop", ""],
        ]),
      }),
    );
    expect(command).toBe("MAIL FROM:<sender@example.com> X-TRACE=1 NOOP");
  });
});

describe("buildRcptToCommand", () => {
  it("builds a plain recipient command", () => {
    const recipient = envelope().recipients[0];
    expect(recipient).toBeDefined();
    expect(buildRcptToCommand(context([]), recipient!, false)).toBe("RCPT TO:<rcpt@example.net>");
  });

  it("adds NOTIFY and ORCPT when DSN is advertised", () => {
    const command = buildRcptToCommand(
      context(["DSN"]),
      {
        address: { localPart: "rcpt", domain: "example.net" },
        dsnNotify: ["SUCCESS", "FAILURE"],
        dsnOrcpt: "rfc822;orig@example.com",
      },
      false,
    );
    expect(command).toBe(
      "RCPT TO:<rcpt@example.net> NOTIFY=SUCCESS,FAILURE ORCPT=rfc822;orig@example.com",
    );
  });

  it("omits DSN parameters when the server does not support them", () => {
    const command = buildRcptToCommand(
      context([]),
      {
        address: { localPart: "rcpt", domain: "example.net" },
        dsnNotify: ["SUCCESS"],
      },
      false,
    );
    expect(command).toBe("RCPT TO:<rcpt@example.net>");
  });

  it("rejects a malformed ORCPT", () => {
    expect(() =>
      buildRcptToCommand(
        context(["DSN"]),
        { address: { localPart: "rcpt", domain: "example.net" }, dsnOrcpt: "rfc822" },
        false,
      ),
    ).toThrow(/ORCPT/);
  });
});

describe("dotStuff", () => {
  it("returns empty input unchanged", () => {
    expect(dotStuff(new Uint8Array())).toHaveLength(0);
  });

  it("returns input without leading dots unchanged", () => {
    const input = encoder.encode("Hello World\r\n");
    expect(dotStuff(input)).toBe(input);
  });

  it("stuffs a lone dot line", () => {
    expect(decoder.decode(dotStuff(encoder.encode(".\r\n")))).toBe("..\r\n");
  });

  it("stuffs multiple dot lines", () => {
    expect(decoder.decode(dotStuff(encoder.encode(".first\r\n.second\r\n.third\r\n")))).toBe(
      "..first\r\n..second\r\n..third\r\n",
    );
  });

  it("stuffs mixed content", () => {
    const input = "Normal line\r\n.dot line\r\nAnother normal\r\n.another dot\r\n";
    expect(decoder.decode(dotStuff(encoder.encode(input)))).toBe(
      "Normal line\r\n..dot line\r\nAnother normal\r\n..another dot\r\n",
    );
  });
});

describe("extractMessageId", () => {
  it.each([
    ["<incomplete", ""],
    ["Ok: queued as ABC123 extra", "ABC123"],
    ["message id=XYZ789 accepted", "XYZ789"],
    ["   ", ""],
    ["queued as <ID@host>", "<ID@host>"],
    ["no identifier here", ""],
  ])("extracts %j as %j", (message, expected) => {
    expect(extractMessageId(message)).toBe(expected);
  });
});
