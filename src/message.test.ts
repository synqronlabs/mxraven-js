import { describe, expect, it } from "vitest";

import { mailboxToString } from "./internal/address.js";
import { Message } from "./message.js";

/** Joins folded header continuation lines for assertions. */
function unfoldHeaders(value: string): string {
  return value.replace(/\r\n[ \t]+/g, " ");
}

describe("Message", () => {
  it("builds a plain-text message", () => {
    const built = new Message()
      .from("Acme <noreply@acme.example>")
      .to("customer@example.com")
      .subject("Your receipt")
      .text("Thanks for your order.")
      .build();

    expect(built.from?.domain).toBe("acme.example");
    expect(built.recipients.map(mailboxToString)).toEqual(["customer@example.com"]);
    expect(built.headerBlock).toContain("From: Acme <noreply@acme.example>\r\n");
    expect(built.headerBlock).toContain("To: customer@example.com\r\n");
    expect(built.headerBlock).toContain("Subject: Your receipt\r\n");
    expect(built.headerBlock).toContain("MIME-Version: 1.0\r\n");
    expect(built.headerBlock).toContain("Content-Type: text/plain; charset=utf-8\r\n");
    expect(built.headerBlock).toContain("Content-Transfer-Encoding: 7bit\r\n");
    expect(built.headerBlock).toMatch(/\r\nMessage-ID: <[^>]+@acme\.example>\r\n/);
    expect(built.body).toBe("Thanks for your order.");
    expect(built.smtpUtf8).toBe(false);
  });

  it("builds an HTML-only message", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .html("<p>Hello</p>")
      .build();

    expect(built.headerBlock).toContain("Content-Type: text/html; charset=utf-8\r\n");
    expect(built.body).toBe("<p>Hello</p>");
  });

  it("builds a multipart/alternative message for text and HTML", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .text("Hello")
      .html("<p>Hello</p>")
      .build();

    expect(unfoldHeaders(built.headerBlock)).toMatch(
      /Content-Type: multipart\/alternative; boundary="[^"]+"/,
    );
    expect(built.body).toContain("text/plain; charset=utf-8");
    expect(built.body).toContain("text/html; charset=utf-8");
  });

  it("wraps attachments in multipart/mixed", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .text("See attached.")
      .attachFile("report.pdf", new Uint8Array([1, 2, 3]))
      .build();

    expect(unfoldHeaders(built.headerBlock)).toMatch(
      /Content-Type: multipart\/mixed; boundary="[^"]+"/,
    );
    expect(built.headerBlock).not.toContain("Content-Type: text/plain");
    expect(built.body).toContain('filename="report.pdf"');
    expect(built.body).toContain("AQID");
  });

  it("keeps Bcc recipients out of the headers", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .bcc("audit@example.com")
      .text("Hi")
      .build();

    expect(built.recipients.map(mailboxToString)).toEqual([
      "customer@example.com",
      "audit@example.com",
    ]);
    expect(built.headerBlock).not.toContain("Bcc:");
    expect(built.headerBlock).not.toContain("audit@example.com");
  });

  it("uses a null reverse-path while keeping the From header", () => {
    const built = new Message()
      .from("Bounce <bounce@acme.example>")
      .to("customer@example.com")
      .nullSender()
      .text("Bounce")
      .build();

    expect(built.from).toBeUndefined();
    expect(built.headerBlock).toContain("From: Bounce <bounce@acme.example>\r\n");
  });

  it("encodes a non-ASCII subject", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .subject("Héllo")
      .text("Hi")
      .build();

    expect(built.headerBlock).toContain("Subject: =?UTF-8?B?");
  });

  it("wraps a bare Message-ID", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .messageId("abc@example.com")
      .text("Hi")
      .build();

    expect(built.headerBlock).toContain("Message-ID: <abc@example.com>\r\n");
  });

  it("throws when no recipient is present", () => {
    expect(() => new Message().from("noreply@acme.example").text("Hi").build()).toThrow(
      AggregateError,
    );
  });

  it("throws for an invalid address", () => {
    expect(() => new Message().from("not an address").to("a@example.com").build()).toThrow(
      AggregateError,
    );
  });

  it("rejects header values containing line breaks", () => {
    expect(() =>
      new Message()
        .from("noreply@acme.example")
        .to("customer@example.com")
        .header("X-Test", "a\r\nBcc: attacker@example.com")
        .build(),
    ).toThrow(AggregateError);
  });

  it("adds Cc to the headers and the envelope", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .cc("ops@example.com")
      .text("Hi")
      .build();

    expect(built.headerBlock).toContain("Cc: ops@example.com\r\n");
    expect(built.recipients.map(mailboxToString)).toEqual([
      "customer@example.com",
      "ops@example.com",
    ]);
  });

  it("throws for an invalid recipient", () => {
    expect(() => new Message().from("noreply@acme.example").to("not an address").build()).toThrow(
      AggregateError,
    );
  });

  it("honors an explicit Date", () => {
    const built = new Message()
      .from("noreply@acme.example")
      .to("customer@example.com")
      .date(new Date(Date.UTC(2026, 0, 2, 15, 4, 5)))
      .text("Hi")
      .build();

    expect(built.headerBlock).toMatch(/Date: .*2026/);
  });

  it("attaches a file with a default content type", () => {
    const built = new Message()
      .from("a@example.com")
      .to("b@example.com")
      .text("hello")
      .attachFile("notes.txt", new TextEncoder().encode("attached"))
      .attachInline("logo.png", "logo", new TextEncoder().encode("png"))
      .build();

    for (const token of ["hello", "notes.txt", "YXR0YWNoZWQ=", "logo.png", "inline", "cG5n"]) {
      expect(built.body).toContain(token);
    }
  });

  it("falls back to text/plain for an attachment with no body", () => {
    const built = new Message()
      .from("a@example.com")
      .to("b@example.com")
      .attachFile("notes.txt", new TextEncoder().encode("attached"))
      .build();

    expect(built.body).toContain("Content-Type: text/plain; charset=utf-8");
    expect(built.body).toContain("Content-Transfer-Encoding: 7bit");
  });

  it("rejects an attachment filename containing line breaks", () => {
    expect(() =>
      new Message()
        .from("a@example.com")
        .to("b@example.com")
        .attachFile("bad\r\nname.txt", new Uint8Array([1]))
        .build(),
    ).toThrow(AggregateError);
  });

  it.each([
    ["non-ASCII local part", "üser@example.com", "a@example.com"],
    ["non-ASCII domain", "user@münchen.de", "a@example.com"],
  ])("flags SMTPUTF8 for a %s", (_name, from, to) => {
    const built = new Message().from(from).to(to).text("Hi").build();
    expect(built.smtpUtf8).toBe(true);
  });

  it("flags SMTPUTF8 for a non-ASCII header value", () => {
    const built = new Message()
      .from("a@example.com")
      .to("b@example.com")
      .header("X-Custom", "こんにちは")
      .text("Hi")
      .build();

    expect(built.smtpUtf8).toBe(true);
  });
});
