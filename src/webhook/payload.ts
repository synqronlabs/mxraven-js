/**
 * mxRaven webhook payload shapes.
 */

/** Identifies the shape of a decoded webhook payload. */
export const eventType = {
  /** A `DELIVER_WEBHOOK` delivery carrying a complete inbound message. */
  inboundEmail: "inbound_email",
  /** A `NOTIFY_WEBHOOK` delivery carrying the status of an object-storage write. */
  storageStatus: "s3_egress_status",
  /**
   * A `NOTIFY_WEBHOOK` delivery carrying the status of an SMTP delivery.
   *
   * The SMTP producer does not send an `event_type` field, so this value is
   * assigned by {@link decode}.
   */
  deliveryStatus: "delivery_status",
} as const;

/** Identifies the shape of a decoded webhook payload. */
export type EventType = (typeof eventType)[keyof typeof eventType];

/** The lifecycle state reported by a delivery-status webhook. */
export const statusOutcome = {
  /** A delivery attempt started. */
  attempted: "attempted",
  /** The destination accepted the message. */
  delivered: "delivered",
  /** The destination temporarily rejected the message. */
  deferred: "deferred",
  /** Delivery failed permanently. */
  failed: "failed",
  /** The delivery deadline passed before success. */
  expired: "expired",
  /** Delivery was skipped by a suppression rule. It is reported for SMTP deliveries only. */
  suppressed: "suppressed",
} as const;

/** The lifecycle state reported by a delivery-status webhook. */
export type StatusOutcome = (typeof statusOutcome)[keyof typeof statusOutcome];

/**
 * The final routing action recorded for an inbound message.
 *
 * Values are the mxRaven worker enum names.
 */
export const terminalAction = {
  /** Deliver through a dedicated IP pool. */
  deliverDedicated: "TERMINAL_ACTION_TYPE_DELIVER_DEDICATED",
  /** Relay through the configured smarthost. */
  smarthostRelay: "TERMINAL_ACTION_TYPE_SMARTHOST_RELAY",
  /** Deliver to a webhook endpoint. */
  deliverWebhook: "TERMINAL_ACTION_TYPE_DELIVER_WEBHOOK",
  /** Forward the message to an SMTP destination. */
  smtpForward: "TERMINAL_ACTION_TYPE_SMTP_FORWARD",
  /** Relay the message to another MX. */
  relay: "TERMINAL_ACTION_TYPE_RELAY",
  /** Store the message in object storage. */
  s3Store: "TERMINAL_ACTION_TYPE_S3_STORE",
  /** Send an automatic reply. */
  autoReply: "TERMINAL_ACTION_TYPE_AUTO_REPLY",
  /** Accept and discard the message. */
  drop: "TERMINAL_ACTION_TYPE_DROP",
  /** Reject the message. */
  reject: "TERMINAL_ACTION_TYPE_REJECT",
  /** Deliver the message normally. */
  deliver: "TERMINAL_ACTION_TYPE_DELIVER",
  /** Handle a DSN at an SRS return address. */
  srsReturn: "TERMINAL_ACTION_TYPE_SRS_RETURN",
  /** Generate a local DSN. */
  localDsn: "TERMINAL_ACTION_TYPE_LOCAL_DSN",
} as const;

/** The final routing action recorded for an inbound message. */
export type TerminalAction = (typeof terminalAction)[keyof typeof terminalAction];

/** A decoded webhook delivery. */
export type Event =
  | { readonly type: typeof eventType.inboundEmail; readonly inboundEmail: InboundEmail }
  | { readonly type: typeof eventType.deliveryStatus; readonly deliveryStatus: DeliveryStatus }
  | { readonly type: typeof eventType.storageStatus; readonly storageStatus: StorageStatus };

/** The final routing outcome for an inbound message. */
export interface RoutingDecision {
  /** The final terminal action. Values are the mxRaven worker enum names. */
  readonly terminal_action: TerminalAction;
  /** The rule that selected the terminal action, when one matched. */
  readonly matched_rule_id?: string;
  /** Whether the listener default was used because no rule produced a terminal action. */
  readonly used_listener_default: boolean;
}

/** Spam and malware scan results. */
export interface Verdicts {
  /** The scanner action description. */
  readonly action: string;
  /** The spam score that was assigned. */
  readonly score: number;
  /** The threshold the message was compared against. */
  readonly required_score: number;
  /** Whether the message was classified as spam. */
  readonly is_spam: boolean;
  /** Whether malware was detected. */
  readonly has_malware: boolean;
  /** The detected malware signatures. */
  readonly malware_names: readonly string[];
  /** Whether scanning was skipped. */
  readonly is_skipped: boolean;
  /** The scanner error, when scanning failed. */
  readonly error: string;
}

/** The SMTP envelope of a message. */
export interface WebhookEnvelope {
  /** The envelope sender. It may be empty for a null reverse-path. */
  readonly mail_from: string;
  /** The envelope recipients. */
  readonly rcpt_to: readonly string[];
}

/** A summary of the parsed message headers. */
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
  readonly message_id?: string;
  /** The raw Date header. */
  readonly date?: string;
}

/** One message header occurrence. */
export interface HeaderField {
  /** The header field name. */
  readonly name: string;
  /** The header field value. */
  readonly value: string;
}

/**
 * Time-limited access to the raw RFC 822 message.
 *
 * Use {@link fetchRawEmail} to download the content.
 */
export interface RawEmail {
  /** The message download URL. */
  readonly url: string;
  /** The authorization scheme, normally `Bearer`. */
  readonly token_type?: string;
  /** The bearer token for the download URL. Treat it as a secret and do not log it. */
  readonly access_token: string;
  /** The Unix time, in seconds, when the token expires. */
  readonly expires_at_utc?: number;
  /** The raw message size. */
  readonly size_bytes?: number;
  /** The lowercase hex SHA-256 of the raw message bytes. */
  readonly sha256_hex?: string;
  /** The parsed message media type. */
  readonly content_type?: string;
}

/** The `DELIVER_WEBHOOK` payload. */
export interface InboundEmail {
  /** Always `inbound_email`. */
  readonly event_type: string;
  /** The delivery task identifier, stable across retries. */
  readonly task_id: string;
  /** The owning tenant. */
  readonly tenant_id: string;
  /** The listener that accepted the message. */
  readonly listener_id: string;
  /** The delivery attempt number, starting at 1. */
  readonly attempt: number;
  /** The Unix time, in seconds, when mxRaven accepted the message. */
  readonly accepted_at_utc: number;
  /** The Unix time, in seconds, when this delivery was built. */
  readonly occurred_at_utc: number;
  /** The final routing outcome. */
  readonly routing_decision: RoutingDecision;
  /** The spam and malware scan results, when scanning ran. */
  readonly verdicts?: Verdicts;
  /** The SMTP envelope. */
  readonly envelope: WebhookEnvelope;
  /** The parsed message header summary. */
  readonly message: MessageSummary;
  /** Every message header in the order received. */
  readonly headers: readonly HeaderField[];
  /** Time-limited access to the raw RFC 822 message. */
  readonly raw_email: RawEmail;
}

/** The SMTP `NOTIFY_WEBHOOK` payload. */
export interface DeliveryStatus {
  /** The delivery task identifier, stable across attempts. */
  readonly task_id: string;
  /** The owning tenant. */
  readonly tenant_id: string;
  /** The source listener. */
  readonly listener_id: string;
  /** The delivery outcome. */
  readonly status: StatusOutcome;
  /** The delivery attempt number, starting at 1. */
  readonly attempt: number;
  /** The Unix time, in seconds, when mxRaven accepted the message. */
  readonly accepted_at_utc: number;
  /** The Unix time, in seconds, when this status was built. */
  readonly occurred_at_utc: number;
  /** The egress source address, when known. */
  readonly source_ip?: string;
  /** The recipient domain. */
  readonly destination_domain?: string;
  /** The remote MTA hostname, when known. */
  readonly remote_host?: string;
  /** The remote SMTP reply code. */
  readonly smtp_code?: number;
  /** The RFC 3463 enhanced status code. */
  readonly enhanced_status_code?: string;
  /** The remote reply text, truncated to 512 bytes. */
  readonly remote_response?: string;
  /** The Unix time, in seconds, of the next attempt for a deferred status. */
  readonly next_retry_at_utc?: number;
  /** Links a generated DSN back to its original task. */
  readonly correlation_task_id?: string;
}

/** The object-storage `NOTIFY_WEBHOOK` payload. */
export interface StorageStatus {
  /** Always `s3_egress_status`. */
  readonly event_type: string;
  /** The storage task identifier. */
  readonly task_id?: string;
  /** The owning tenant. */
  readonly tenant_id?: string;
  /** The source listener. */
  readonly listener_id?: string;
  /** The storage outcome. */
  readonly status: StatusOutcome;
  /** The delivery attempt number, starting at 1. */
  readonly attempt: number;
  /** The Unix time, in seconds, when mxRaven accepted the message. */
  readonly accepted_at_utc?: number;
  /** The Unix time, in seconds, when this status was built. */
  readonly occurred_at_utc: number;
  /** The storage integration identifier. */
  readonly storage_ref?: string;
  /** The destination bucket. */
  readonly bucket_name?: string;
  /** The stored object key. */
  readonly object_key?: string;
  /** The storage endpoint host. */
  readonly endpoint_host?: string;
  /** The storage provider response status. */
  readonly status_code?: number;
  /** The storage provider error code. */
  readonly error_code?: string;
  /** The failure description, truncated to 512 bytes. */
  readonly message?: string;
  /** The Unix time, in seconds, of the next attempt for a deferred status. */
  readonly next_retry_at_utc?: number;
}
