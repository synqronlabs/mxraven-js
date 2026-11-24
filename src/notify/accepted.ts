/**
 * Decoded accepted-message payload shapes.
 */

import type { RoutingDecision } from "./routing.js";

/** Spam and malware scan results. @public */
export interface Verdicts {
  /** The scanner action description. */
  readonly action: string;
  /** The spam score that was assigned. */
  readonly score: number;
  /** The threshold the message was compared against. */
  readonly requiredScore: number;
  /** Whether the message was classified as spam. */
  readonly isSpam: boolean;
  /** Whether malware was detected. */
  readonly hasMalware: boolean;
  /** The detected malware signatures. */
  readonly malwareNames: readonly string[];
  /** Whether scanning was skipped. */
  readonly isSkipped: boolean;
  /** The scanner error, when scanning failed. */
  readonly error: string;
}

/** The SMTP envelope of an accepted message. @public */
export interface AcceptedEnvelope {
  /** The envelope sender. It may be empty for a null reverse-path. */
  readonly mailFrom: string;
  /** The envelope recipients. */
  readonly rcptTo: readonly string[];
}

/** A summary of the parsed message headers. @public */
export interface MessageSummary {
  /** The decoded Subject header. */
  readonly subject?: string;
  /** The decoded From mailboxes. */
  readonly from?: readonly string[];
  /** The decoded To mailboxes. */
  readonly to?: readonly string[];
  /** The decoded Cc mailboxes. */
  readonly cc?: readonly string[];
  /** The Message-ID header. */
  readonly messageId?: string;
  /** The raw Date header. */
  readonly date?: string;
}

/** One message header occurrence. @public */
export interface HeaderField {
  /** The header field name. */
  readonly name: string;
  /** The header field value. */
  readonly value: string;
}

/**
 * Time-limited access to the raw RFC 822 message.
 *
 * Use {@link fetchRawEmail} or `fetchAndParseRawEmail` from
 * `@mxraven/mail/mime` to download the content. Raw-message access is granted
 * to MTA listeners only, so every field is empty on a submission listener's
 * accepted event.
 *
 * @public
 */
export interface RawEmail {
  /** The message download URL, or an empty string without raw-message access. */
  readonly url: string;
  /** The authorization scheme, normally `Bearer`. */
  readonly tokenType?: string;
  /**
   * The bearer token for the download URL, or an empty string without
   * raw-message access. Treat it as a secret and do not log it.
   */
  readonly accessToken: string;
  /** The Unix time, in seconds, when the token expires. */
  readonly expiresAtUtc?: number;
  /** The raw message size in bytes. */
  readonly sizeBytes?: number;
  /** The lowercase hex SHA-256 of the raw message bytes. */
  readonly sha256Hex?: string;
  /** The parsed message media type. */
  readonly contentType?: string;
}

/**
 * A message a listener accepted.
 *
 * The event is published after acceptance and after the routing script
 * resolved, including when the terminal drops the message: acceptance and
 * disposal are separate facts.
 *
 * @public
 */
export interface AcceptedMessage {
  /** The delivery task identifier, stable across retries. */
  readonly taskId: string;
  /** The owning tenant. */
  readonly tenantId: string;
  /** The listener that accepted the message. */
  readonly listenerId: string;
  /**
   * The mxRaven message reference.
   *
   * For an outbound listener it is the value the submission reply reported as
   * `message_ref`, so an event can be joined to the send that produced it.
   */
  readonly messageRef?: string;
  /** The delivery attempt number, starting at 1. */
  readonly attempt: number;
  /** The Unix time, in seconds, when mxRaven accepted the message. */
  readonly acceptedAtUtc: number;
  /** The Unix time, in seconds, when the event was built. */
  readonly occurredAtUtc: number;
  /** What the listener's routing script did for this message. */
  readonly routingDecision: RoutingDecision;
  /** The spam and malware scan results, when scanning ran. */
  readonly verdicts?: Verdicts;
  /** The SMTP envelope. */
  readonly envelope: AcceptedEnvelope;
  /** The parsed message header summary. */
  readonly message: MessageSummary;
  /** Every message header, sorted by name in the producer's order. */
  readonly headers: readonly HeaderField[];
  /**
   * Access to the full raw RFC 822 message.
   *
   * The body and attachments are not inlined in the event. Check
   * {@link RawEmail.accessToken} before downloading: it is empty on a
   * submission listener's event.
   */
  readonly rawEmail: RawEmail;
}
