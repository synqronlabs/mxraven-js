import { describe, expect, it } from "vitest";

import { parseEmail } from "./parse.js";

/** Encodes a message fixture as UTF-8 bytes. */
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Ports the `ALTERNATIVE_WITH_ATTACHMENT` fixture from the Java SDK's
 * `MimeParserTest`, using LF line endings to exercise lenient parsing.
 */
const ALTERNATIVE_WITH_ATTACHMENT = [
  "Subject: Test message",
  'From: "Alice Example" <alice@example.com>',
  'To: bob@example.com, "Carol" <carol@example.com>',
  "Date: Sun, 13 Sep 2026 14:30:00 +0000",
  "Message-ID: <abc@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="BOUND1"',
  "",
  "--BOUND1",
  'Content-Type: multipart/alternative; boundary="BOUND2"',
  "",
  "--BOUND2",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hello =E2=9C=93",
  "soft=",
  "break",
  "--BOUND2",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: 7bit",
  "",
  "<html><body>Hi</body></html>",
  "--BOUND2--",
  "--BOUND1",
  'Content-Type: application/octet-stream; name="hello.txt"',
  'Content-Disposition: attachment; filename="hello.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  "SGVsbG8gZmlsZSE=",
  "--BOUND1--",
].join("\n");

describe("parseEmail", () => {
  it("parses headers, addresses, and the date", () => {
    const email = parseEmail(encode(ALTERNATIVE_WITH_ATTACHMENT));

    expect(email.subject).toBe("Test message");
    expect(email.messageId).toBe("abc@example.com");
    expect(email.date?.toISOString()).toBe("2026-09-13T14:30:00.000Z");
    expect(email.from).toEqual([{ address: "alice@example.com", name: "Alice Example" }]);
    expect(email.to).toHaveLength(2);
    expect(email.to[1]).toEqual({ address: "carol@example.com", name: "Carol" });
  });

  it("extracts text and HTML bodies", () => {
    const email = parseEmail(encode(ALTERNATIVE_WITH_ATTACHMENT));

    expect(email.text).toBe("Hello \u2713\nsoftbreak");
    expect(email.html).toBe("<html><body>Hi</body></html>");
  });

  it("extracts decoded attachments", () => {
    const email = parseEmail(encode(ALTERNATIVE_WITH_ATTACHMENT));

    expect(email.attachments).toHaveLength(1);
    const attachment = email.attachments[0];
    expect(attachment?.filename).toBe("hello.txt");
    expect(attachment?.contentType).toBe("application/octet-stream");
    expect(attachment?.inline).toBe(false);
    expect(new TextDecoder().decode(attachment?.content)).toBe("Hello file!");
  });

  it("decodes RFC 2047 encoded words in the subject and display name", () => {
    const raw = [
      "Subject: =?UTF-8?B?SGVsbG8gV29ybGQ=?=",
      "From: =?UTF-8?Q?Jos=C3=A9?= <jose@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body",
    ].join("\r\n");

    const email = parseEmail(encode(raw));
    expect(email.subject).toBe("Hello World");
    expect(email.from).toEqual([{ address: "jose@example.com", name: "Jos\u00e9" }]);
  });

  it("decodes a simple body", () => {
    const email = parseEmail(
      encode("Subject: Simple\r\nContent-Type: text/plain\r\n\r\njust text"),
    );

    expect(email.text).toBe("just text");
    expect(email.attachments).toEqual([]);
  });

  it("decodes RFC 2231 attachment filenames", () => {
    const raw = [
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename*=UTF-8''%C3%A9.txt",
      "",
      "data",
    ].join("\r\n");

    expect(parseEmail(encode(raw)).attachments[0]?.filename).toBe("\u00e9.txt");
  });

  it("reassembles RFC 2231 parameter continuations", () => {
    const raw = [
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename*0*=UTF-8''%C3%A9; filename*1*=.txt",
      "",
      "data",
    ].join("\r\n");

    expect(parseEmail(encode(raw)).attachments[0]?.filename).toBe("\u00e9.txt");
  });

  it("handles an empty message", () => {
    const email = parseEmail(new Uint8Array());

    expect(email.subject).toBeUndefined();
    expect(email.text).toBeUndefined();
    expect(email.headers).toEqual([]);
    expect(email.attachments).toEqual([]);
  });

  it("handles LF-only line endings", () => {
    const email = parseEmail(encode("Subject: LF\n\nbody text"));

    expect(email.subject).toBe("LF");
    expect(email.text).toBe("body text");
  });

  it("decodes Base64 bodies with embedded whitespace", () => {
    const raw = [
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="a.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      "SGVs",
      "bG8g",
      "ZmlsZSE=",
    ].join("\r\n");

    const attachment = parseEmail(encode(raw)).attachments[0];
    expect(new TextDecoder().decode(attachment?.content)).toBe("Hello file!");
  });

  it("exposes inline parts from multipart/related", () => {
    const raw = [
      'Content-Type: multipart/related; boundary="R"',
      "",
      "--R",
      "Content-Type: text/html",
      "",
      '<img src="cid:img1">',
      "--R",
      "Content-Type: image/png",
      "Content-ID: <img1>",
      'Content-Disposition: inline; filename="logo.png"',
      "Content-Transfer-Encoding: base64",
      "",
      "AQID",
      "--R--",
    ].join("\r\n");

    const email = parseEmail(encode(raw));
    expect(email.html).toBe('<img src="cid:img1">');
    expect(email.attachments).toEqual([
      {
        filename: "logo.png",
        contentType: "image/png",
        contentId: "img1",
        inline: true,
        content: Uint8Array.from([1, 2, 3]),
      },
    ]);
  });

  it("keeps quoted commas in address display names", () => {
    const raw = [
      'To: "Doe, John" <john@example.com>, jane@example.com',
      "Content-Type: text/plain",
      "",
      "body",
    ].join("\r\n");

    const email = parseEmail(encode(raw));
    expect(email.to).toEqual([
      { address: "john@example.com", name: "Doe, John" },
      { address: "jane@example.com" },
    ]);
  });

  it("surfaces message/rfc822 parts as attachments", () => {
    const raw = [
      "Content-Type: message/rfc822",
      "",
      "From: inner@example.com",
      "Subject: Inner",
      "",
      "inner body",
    ].join("\r\n");

    const email = parseEmail(encode(raw));
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]?.contentType).toBe("message/rfc822");
    expect(new TextDecoder().decode(email.attachments[0]?.content)).toContain("inner body");
  });

  it("unfolds header continuation lines", () => {
    const email = parseEmail(encode("Subject: Hello\r\n World\r\n\r\nbody"));

    expect(email.subject).toBe("Hello World");
  });

  it("decodes declared non-UTF-8 charsets", () => {
    const prefix = encode("Content-Type: text/plain; charset=windows-1252\r\n\r\n");
    const bytes = new Uint8Array(prefix.length + 1);
    bytes.set(prefix);
    bytes[prefix.length] = 0x93;

    expect(parseEmail(bytes).text).toBe("\u201c");
  });

  it("falls back to UTF-8 for unknown charsets", () => {
    const raw = ["Content-Type: text/plain; charset=x-unknown", "", "h\u00e9llo"].join("\r\n");

    expect(parseEmail(encode(raw)).text).toBe("h\u00e9llo");
  });

  it("rejects deeply nested messages", () => {
    let message = "Content-Type: text/plain\r\n\r\nleaf";
    for (let depth = 0; depth < 25; depth += 1) {
      const boundary = `D${depth}`;
      message = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${message}\r\n--${boundary}--`;
    }

    expect(() => parseEmail(encode(message))).toThrow(/nesting/);
  });

  it("returns attachment content that does not alias the input", () => {
    const raw = [
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="a.bin"',
      "",
      "payload",
    ].join("\r\n");
    const bytes = encode(raw);
    const email = parseEmail(bytes);

    bytes.fill(0);
    expect(new TextDecoder().decode(email.attachments[0]?.content)).toBe("payload");
  });
});
