import { describe, expect, it } from "vitest";

import {
  buildMultipartAlternative,
  encodeBase64Lines,
  encodeQuotedPrintable,
  normalizeLineEndings,
  selectTextEncoding,
  wrapAttachments,
} from "./mime.js";

describe("normalizeLineEndings", () => {
  it.each([
    ["lf", "a\nb", "a\r\nb"],
    ["crlf", "a\r\nb", "a\r\nb"],
    ["cr", "a\rb", "a\r\nb"],
    ["mixed", "a\r\nb\nc\rd", "a\r\nb\r\nc\r\nd"],
  ])("normalizes %s endings", (_name, input, expected) => {
    expect(normalizeLineEndings(input)).toBe(expected);
  });
});

describe("encodeBase64Lines", () => {
  it("returns an empty string for no data", () => {
    expect(encodeBase64Lines(new Uint8Array())).toBe("");
  });

  it("wraps Base64 at 76 characters", () => {
    const data = new TextEncoder().encode("abcdef".repeat(20));
    const encoded = encodeBase64Lines(data);
    const firstLine = encoded.slice(0, 76);
    expect(encoded.startsWith(`${firstLine}\r\n`)).toBe(true);
    for (const line of encoded.replace(/\r\n$/, "").split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});

describe("buildMultipartAlternative", () => {
  it("renders both text and HTML parts", () => {
    const result = buildMultipartAlternative("hello", "<p>hello</p>");
    expect(result.contentType).toMatch(/^multipart\/alternative; boundary=".+"$/);
    expect(result.contentTransferEncoding).toBe("7bit");
    expect(result.data).toContain("Content-Type: text/plain; charset=utf-8\r\n");
    expect(result.data).toContain("Content-Type: text/html; charset=utf-8\r\n");
    expect(result.data).toContain("hello");
    expect(result.data.endsWith("--\r\n")).toBe(true);
  });

  it("selects 8bit when either part contains non-ASCII", () => {
    const result = buildMultipartAlternative("héllo", "<p>hello</p>");
    expect(result.contentTransferEncoding).toBe("8bit");
  });

  it("quoted-printable-encodes parts with over-long lines", () => {
    const longHtml = `<p>${"a".repeat(1200)}</p>`;
    const result = buildMultipartAlternative("hello", longHtml);
    expect(result.data).toContain("Content-Transfer-Encoding: quoted-printable\r\n");
    expect(result.contentTransferEncoding).toBe("7bit");
    for (const line of result.data.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe("selectTextEncoding", () => {
  it("selects 7bit for plain ASCII", () => {
    expect(selectTextEncoding("hello")).toBe("7bit");
  });

  it("selects 8bit for short non-ASCII content", () => {
    expect(selectTextEncoding("héllo")).toBe("8bit");
  });

  it("selects quoted-printable when a line exceeds the RFC 5322 limit", () => {
    expect(selectTextEncoding("a".repeat(998))).toBe("7bit");
    expect(selectTextEncoding("a".repeat(999))).toBe("quoted-printable");
  });
});

describe("encodeQuotedPrintable", () => {
  it("encodes non-ASCII bytes and trailing whitespace", () => {
    expect(encodeQuotedPrintable("Héllo ")).toBe("H=C3=A9llo=20\r\n");
  });

  it("soft-wraps long lines within 76 characters", () => {
    const encoded = encodeQuotedPrintable("a".repeat(200));
    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(encoded.replace(/=\r\n/g, "")).toBe(`${"a".repeat(200)}\r\n`);
  });
});

describe("wrapAttachments", () => {
  it("emits the body part, attachment part, and closing boundary", () => {
    const result = wrapAttachments(
      {
        contentType: "text/plain; charset=utf-8",
        contentTransferEncoding: "7bit",
        data: "hello\r\n",
      },
      [
        {
          filename: "report.pdf",
          contentType: "application/pdf",
          data: new Uint8Array([1, 2, 3]),
        },
      ],
    );
    expect(result.contentType).toMatch(/^multipart\/mixed; boundary=".+"$/);
    expect(result.contentTransferEncoding).toBe("7bit");
    expect(result.data).toContain('Content-Disposition: attachment; filename="report.pdf"\r\n');
    expect(result.data).toContain("Content-Transfer-Encoding: base64\r\n");
    expect(result.data).toContain("AQID");
    expect(result.data.endsWith("--\r\n")).toBe(true);
  });

  it("uses inline disposition and Content-ID for inline parts", () => {
    const result = wrapAttachments(
      {
        contentType: "text/plain; charset=utf-8",
        contentTransferEncoding: "7bit",
        data: "",
      },
      [
        {
          filename: "logo.png",
          contentType: "image/png",
          data: new Uint8Array([9]),
          inline: true,
          contentId: "logo",
        },
      ],
    );
    expect(result.data).toContain('Content-Disposition: inline; filename="logo.png"\r\n');
    expect(result.data).toContain("Content-ID: <logo>\r\n");
  });
});
