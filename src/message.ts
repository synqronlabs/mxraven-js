import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  containsNonAscii,
  encodeRfc2047,
  formatAddress,
  formatAddressList,
  parseAddress,
  type MailboxAddress,
} from "./internal/address.js";
import {
  getHeader,
  serializeHeaders,
  validateHeader,
  validateHeaderValue,
  type HeaderField,
} from "./internal/headers.js";
import {
  buildMultipartAlternative,
  normalizeLineEndings,
  wrapAttachments,
  type BodyPart,
  type MimeAttachment,
} from "./internal/mime.js";

/** A custom message header. */
export interface Header {
  /** The header field name. */
  readonly name: string;
  /** The header field value. It must not contain line breaks. */
  readonly value: string;
}

/**
 * A message attachment.
 *
 * The attachment data is retained by reference until the message is built. Callers must not mutate
 * it in the meantime.
 */
export interface Attachment {
  /** The attachment filename. It may be empty. */
  readonly filename?: string;
  /** The media type. Defaults to `application/octet-stream`. */
  readonly contentType?: string;
  /** The raw attachment content. The caller retains ownership. */
  readonly data: Uint8Array;
  /** Marks the attachment for inline display, for example a `cid:` image. */
  readonly inline?: boolean;
  /** The inline content identifier, without angle brackets. */
  readonly contentId?: string;
}

/**
 * The SMTP envelope for a raw message, independent of the message headers.
 *
 * @public
 */
export interface Envelope {
  /**
   * The envelope sender. An empty or omitted value requests a null reverse-path, which is
   * appropriate for bounce messages.
   */
  readonly from?: string;
  /** At least one envelope recipient. */
  readonly to: readonly string[];
}

/**
 * A built message ready for transmission.
 *
 * @internal
 */
export interface BuiltMessage {
  /** The envelope sender address, or `undefined` for a null reverse-path. */
  readonly from: MailboxAddress | undefined;
  /** The envelope recipients. */
  readonly recipients: readonly MailboxAddress[];
  /** The serialized message header block, CRLF-terminated. */
  readonly headerBlock: string;
  /** The serialized message body. */
  readonly body: string;
  /** The complete RFC 5322 message, ready for transmission. */
  readonly data: Uint8Array;
  /** Whether the envelope requires the `SMTPUTF8` extension. */
  readonly smtpUtf8: boolean;
  /** The approximate message size in bytes, including headers. */
  readonly size: number;
  /** The time the message was built. */
  readonly builtAt: Date;
}

/**
 * A mutable, chainable builder for an email message.
 *
 * Chained methods return the receiver, so a message is normally composed in a single expression. A
 * `Message` is not safe for concurrent use. It can be sent repeatedly; each send serializes the
 * current state.
 *
 * @example
 * ```ts
 * const message = new Message()
 *   .from("Acme <noreply@acme.example>")
 *   .to("customer@example.com")
 *   .subject("Your receipt")
 *   .text("Thanks for your order.")
 *   .html("<p>Thanks for your order.</p>");
 * ```
 *
 * @public
 */
export class Message {
  private fromAddress = "";
  private isNullSender = false;
  private senderAddress = "";
  private replyToAddress = "";
  private toAddresses: string[] = [];
  private ccAddresses: string[] = [];
  private bccAddresses: string[] = [];
  private subjectText = "";
  private textBody: string | undefined;
  private htmlBody: string | undefined;
  private customHeaders: Header[] = [];
  private attachments: Attachment[] = [];
  private messageIdValue = "";
  private inReplyToValue = "";
  private referencesValue: string[] = [];
  private dateValue: Date | undefined;

  /** Sets the envelope sender and the `From` header. */
  from(address: string): this {
    this.fromAddress = address;
    return this;
  }

  /**
   * Uses a null reverse-path while keeping the `From` header.
   *
   * It is intended for bounce and other auto-generated messages. A `From` header is still required
   * for a valid message.
   */
  nullSender(): this {
    this.isNullSender = true;
    return this;
  }

  /** Sets the `Sender` header, required when `From` contains more than one mailbox. */
  sender(address: string): this {
    this.senderAddress = address;
    return this;
  }

  /** Sets the `Reply-To` header. */
  replyTo(address: string): this {
    this.replyToAddress = address;
    return this;
  }

  /** Adds envelope and `To` header recipients. */
  to(addresses: string | readonly string[]): this {
    this.toAddresses.push(...toArray(addresses));
    return this;
  }

  /** Adds envelope and `Cc` header recipients. */
  cc(addresses: string | readonly string[]): this {
    this.ccAddresses.push(...toArray(addresses));
    return this;
  }

  /** Adds envelope recipients without a visible `Bcc` header. */
  bcc(addresses: string | readonly string[]): this {
    this.bccAddresses.push(...toArray(addresses));
    return this;
  }

  /** Sets the `Subject` header. Non-ASCII subjects are RFC 2047 encoded. */
  subject(subject: string): this {
    this.subjectText = subject;
    return this;
  }

  /** Sets the `Message-ID` header. The value is wrapped in angle brackets when needed. */
  messageId(id: string): this {
    this.messageIdValue = id;
    return this;
  }

  /** Sets the `In-Reply-To` header for threading. */
  inReplyTo(id: string): this {
    this.inReplyToValue = id;
    return this;
  }

  /** Sets the `References` header for threading. */
  references(ids: string | readonly string[]): this {
    this.referencesValue.push(...toArray(ids));
    return this;
  }

  /** Sets the `Date` header. When unset, the time of sending is used. */
  date(date: Date): this {
    this.dateValue = date;
    return this;
  }

  /**
   * Sets the plain-text body.
   *
   * When both a text and an HTML body are set, the message is sent as `multipart/alternative`.
   */
  text(body: string): this {
    this.textBody = body;
    return this;
  }

  /**
   * Sets the HTML body.
   *
   * When both a text and an HTML body are set, the message is sent as `multipart/alternative`.
   */
  html(body: string): this {
    this.htmlBody = body;
    return this;
  }

  /** Appends a custom header. */
  header(name: string, value: string): this {
    this.customHeaders.push({ name, value });
    return this;
  }

  /**
   * Appends an attachment.
   *
   * The data is retained by reference until the message is built. Callers must not mutate it in the
   * meantime.
   */
  attach(attachment: Attachment): this {
    this.attachments.push(attachment);
    return this;
  }

  /** Appends a file attachment with an `application/octet-stream` content type. */
  attachFile(filename: string, data: Uint8Array): this {
    return this.attach({ filename, data });
  }

  /** Appends an inline attachment referenced by `contentId`, for example from `cid:` HTML. */
  attachInline(filename: string, contentId: string, data: Uint8Array): this {
    return this.attach({ filename, contentId, data, inline: true });
  }

  /**
   * Serializes the current state into a transmittable message.
   *
   * The returned value is a snapshot: later mutations of this builder do not affect it. The caller
   * owns the returned object.
   *
   * @returns The built message and its envelope.
   * @throws `AggregateError` When one or more addresses or headers are invalid, or when required
   *   fields are missing.
   * @internal
   */
  build(): BuiltMessage {
    const problems: Error[] = [];

    const from = this.parseOptional(this.fromAddress, "from", problems);
    const sender = this.parseOptional(this.senderAddress, "sender", problems);
    const replyTo = this.parseOptional(this.replyToAddress, "reply-to", problems);
    const to = this.parseMany(this.toAddresses, "to", problems);
    const cc = this.parseMany(this.ccAddresses, "cc", problems);
    const bcc = this.parseMany(this.bccAddresses, "bcc", problems);
    const recipients = [...to, ...cc, ...bcc];

    if (
      from === undefined &&
      !this.isNullSender &&
      getHeader(this.customHeaders, "From") === undefined
    ) {
      problems.push(new Error("mail: from address is required"));
    }
    if (recipients.length === 0) {
      problems.push(new Error("mail: at least one recipient is required"));
    }

    const headers: HeaderField[] = [];
    if (from !== undefined) {
      headers.push({ name: "From", value: formatAddress(from) });
    }
    if (sender !== undefined) {
      headers.push({ name: "Sender", value: formatAddress(sender) });
    }
    if (replyTo !== undefined) {
      headers.push({ name: "Reply-To", value: formatAddress(replyTo) });
    }
    if (to.length > 0) {
      headers.push({ name: "To", value: formatAddressList(to) });
    }
    if (cc.length > 0) {
      headers.push({ name: "Cc", value: formatAddressList(cc) });
    }
    if (this.subjectText !== "") {
      headers.push({ name: "Subject", value: encodeHeaderValue(this.subjectText) });
    }
    if (this.messageIdValue !== "") {
      headers.push({ name: "Message-ID", value: wrapAngle(this.messageIdValue) });
    }
    if (this.inReplyToValue !== "") {
      headers.push({ name: "In-Reply-To", value: wrapAngle(this.inReplyToValue) });
    }
    if (this.referencesValue.length > 0) {
      headers.push({ name: "References", value: this.referencesValue.map(wrapAngle).join(" ") });
    }

    for (const header of this.customHeaders) {
      try {
        validateHeader(header.name, header.value);
        headers.push({ name: header.name, value: header.value });
      } catch (error) {
        problems.push(toError(error, `header ${header.name}`));
      }
    }

    if (getHeader(headers, "Date") === undefined) {
      headers.push({ name: "Date", value: formatDate(this.dateValue ?? new Date()) });
    }
    if (getHeader(headers, "Message-ID") === undefined) {
      const domain = from?.domain ?? recipients[0]?.domain ?? "localhost";
      headers.push({ name: "Message-ID", value: `<${Date.now()}.${randomUUID()}@${domain}>` });
    }

    const rendered = this.renderBody(problems);
    if (rendered !== undefined) {
      headers.push({ name: "MIME-Version", value: "1.0" });
      headers.push({ name: "Content-Type", value: rendered.contentType });
      headers.push({ name: "Content-Transfer-Encoding", value: rendered.contentTransferEncoding });
    }

    if (problems.length > 0) {
      throw new AggregateError(problems, "mail: build message");
    }

    const headerBlock = serializeHeaders(headers);
    const data = Buffer.from(`${headerBlock}\r\n${rendered?.data ?? ""}`, "utf8");
    return {
      from: this.isNullSender ? undefined : from,
      recipients,
      headerBlock,
      body: rendered?.data ?? "",
      data,
      smtpUtf8: requiresSmtpUtf8(from, recipients, headers),
      size: data.byteLength,
      builtAt: new Date(),
    };
  }

  /** Renders the body, wrapping attachments in `multipart/mixed` when present. */
  private renderBody(problems: Error[]): BodyPart | undefined {
    let bodyPart: BodyPart | undefined;
    if (this.textBody !== undefined && this.htmlBody !== undefined) {
      const alternative = buildMultipartAlternative(this.textBody, this.htmlBody);
      bodyPart = {
        contentType: alternative.contentType,
        contentTransferEncoding: alternative.contentTransferEncoding,
        data: alternative.data,
      };
    } else if (this.htmlBody !== undefined) {
      bodyPart = renderTextBody("text/html; charset=utf-8", this.htmlBody);
    } else if (this.textBody !== undefined) {
      bodyPart = renderTextBody("text/plain; charset=utf-8", this.textBody);
    }

    if (this.attachments.length === 0) {
      return bodyPart;
    }
    for (const attachment of this.attachments) {
      if (attachment.data.length === 0 && attachment.filename === undefined) {
        problems.push(new Error("mail: attachment requires data or a filename"));
      }
      try {
        if (attachment.filename !== undefined) {
          validateHeaderValue(attachment.filename);
        }
        if (attachment.contentType !== undefined) {
          validateHeaderValue(attachment.contentType);
        }
        if (attachment.contentId !== undefined) {
          validateHeaderValue(attachment.contentId);
        }
      } catch (error) {
        problems.push(toError(error, `attachment ${attachment.filename ?? ""}`.trimEnd()));
      }
    }
    const attachments = this.attachments.map(toMimeAttachment);
    if (bodyPart === undefined) {
      bodyPart = {
        contentType: "text/plain; charset=utf-8",
        contentTransferEncoding: "7bit",
        data: "",
      };
    }
    const mixed = wrapAttachments(bodyPart, attachments);
    return {
      contentType: mixed.contentType,
      contentTransferEncoding: mixed.contentTransferEncoding,
      data: mixed.data,
    };
  }

  /** Parses an optional address, recording a problem when invalid. */
  private parseOptional(
    value: string,
    label: string,
    problems: Error[],
  ): MailboxAddress | undefined {
    if (value.trim() === "") {
      return undefined;
    }
    try {
      return parseAddress(value);
    } catch (error) {
      problems.push(toError(error, label));
      return undefined;
    }
  }

  /** Parses a list of addresses, recording problems for invalid entries. */
  private parseMany(values: readonly string[], label: string, problems: Error[]): MailboxAddress[] {
    const parsed: MailboxAddress[] = [];
    for (const value of values) {
      try {
        parsed.push(parseAddress(value));
      } catch (error) {
        problems.push(toError(error, label));
      }
    }
    return parsed;
  }
}

/** Normalizes a single address or array into an array. */
function toArray(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

/** Renders a simple text or HTML body. */
function renderTextBody(contentType: string, body: string): BodyPart {
  const normalized = normalizeLineEndings(body);
  return {
    contentType,
    contentTransferEncoding: containsNonAscii(normalized) ? "8bit" : "7bit",
    data: normalized,
  };
}

/** Renders a header value, RFC 2047-encoding it when it contains non-ASCII. */
function encodeHeaderValue(value: string): string {
  return containsNonAscii(value) ? encodeRfc2047(value) : value;
}

/** Wraps a message identifier in angle brackets when it is not already. */
function wrapAngle(value: string): string {
  return value.startsWith("<") ? value : `<${value}>`;
}

/** Converts an attachment into its MIME representation. */
function toMimeAttachment(attachment: Attachment): MimeAttachment {
  return {
    filename: attachment.filename,
    contentType: attachment.contentType ?? "application/octet-stream",
    data: attachment.data,
    inline: attachment.inline,
    contentId: attachment.contentId,
  };
}

/** Reports whether the envelope requires the `SMTPUTF8` extension. */
function requiresSmtpUtf8(
  from: MailboxAddress | undefined,
  recipients: readonly MailboxAddress[],
  headers: readonly HeaderField[],
): boolean {
  const addresses = from === undefined ? recipients : [from, ...recipients];
  for (const address of addresses) {
    if (containsNonAscii(address.localPart) || containsNonAscii(address.domain)) {
      return true;
    }
  }
  return headers.some((header) => containsNonAscii(header.value));
}

/** Formats a date using the RFC 5322 date-time syntax. */
function formatDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  const zone = `${sign}${pad2(Math.floor(absolute / 60))}${pad2(absolute % 60)}`;
  const day = days[date.getDay()] ?? "Sun";
  const month = months[date.getMonth()] ?? "Jan";
  return (
    `${day}, ${pad2(date.getDate())} ${month} ${date.getFullYear()} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${zone}`
  );
}

/** Pads a number to two digits. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Adds context to an unknown thrown value. */
function toError(error: unknown, label: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`mail: invalid ${label}: ${message}`, { cause: error });
}
