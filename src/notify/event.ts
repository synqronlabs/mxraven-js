/**
 * Decoded client notification payload shapes.
 */

import type { InboundEmail, StatusOutcome } from "../webhook/payload.js";

/** Identifies which kind of notification an event carries. */
export const notificationKind = {
  /** A message the listener accepted and whose terminal action was resolved. */
  accepted: "accepted",
  /** One delivery attempt for an accepted message on an egress channel. */
  attempt: "attempt",
} as const;

/** Identifies which kind of notification an event carries. */
export type NotificationKind = (typeof notificationKind)[keyof typeof notificationKind];

/** Identifies the egress worker that produced an attempt event. */
export const attemptChannel = {
  /** An SMTP delivery attempt. */
  smtp: "smtp",
  /** An object-storage write attempt. */
  s3: "s3",
  /** A webhook delivery attempt. */
  webhook: "webhook",
} as const;

/** Identifies the egress worker that produced an attempt event. */
export type AttemptChannel = (typeof attemptChannel)[keyof typeof attemptChannel];

/**
 * One delivery attempt for an accepted message.
 *
 * `channel` names the worker that produced the event. The remaining fields
 * describe that channel's protocol and are absent when they do not apply.
 *
 * A rule that chains side-effect actions reports each action it triggers, so a
 * message can produce more than one attempt event. Every attempt carries a
 * `correlationId` that points at the `task_id` of the accepted event for the
 * message it stems from, which is how an attempt joins back to its acceptance.
 * A submission listener's attempts usually share the accepted event's
 * `taskId` as well.
 *
 * @public
 */
export interface AttemptEvent {
  /** The producer's event-type marker, when one is set. SMTP attempts omit it. */
  readonly eventType?: string;
  /** The egress worker that produced the attempt. */
  readonly channel: AttemptChannel;
  /** The delivery task. For a submission listener this equals the accepted event's `task_id`. */
  readonly taskId: string;
  /** The owning tenant. */
  readonly tenantId: string;
  /** The source listener. */
  readonly listenerId: string;
  /**
   * The mxRaven message reference of the message this attempt belongs to. It
   * joins attempts and acceptance events for the same message, including every
   * recipient a single send fanned out to.
   */
  readonly messageRef?: string;
  /** The `task_id` of the accepted event for the message, when one was recorded. */
  readonly correlationId?: string;
  /** The attempt outcome. */
  readonly status: StatusOutcome;
  /** The delivery attempt number, starting at 1. */
  readonly attempt: number;
  /** The Unix time, in seconds, when mxRaven accepted the message. */
  readonly acceptedAtUtc?: number;
  /** The Unix time, in seconds, when the attempt was built. */
  readonly occurredAtUtc: number;

  /** The SMTP egress source address, when known. */
  readonly sourceIp?: string;
  /** The recipient domain for an SMTP attempt. */
  readonly destinationDomain?: string;
  /** The remote MTA hostname, when known. */
  readonly remoteHost?: string;
  /** The remote SMTP reply code. */
  readonly smtpCode?: number;
  /** The RFC 3463 enhanced status code. */
  readonly enhancedStatusCode?: string;
  /** The bounded, machine-readable delivery classification. */
  readonly reason?: string;
  /** The remote reply text, truncated by the server. */
  readonly remoteResponse?: string;
  /** Links a generated DSN back to its original task. */
  readonly correlationTaskId?: string;

  /** The storage integration identifier for an `s3` attempt. */
  readonly storageRef?: string;
  /** The destination bucket for an `s3` attempt. */
  readonly bucketName?: string;
  /** The stored object key for an `s3` attempt. */
  readonly objectKey?: string;
  /** The storage endpoint host for an `s3` attempt. */
  readonly endpointHost?: string;
  /** The storage provider error code, when one was returned. */
  readonly errorCode?: string;

  /** The storage or webhook HTTP response status. */
  readonly statusCode?: number;
  /** The failure description, truncated by the server. */
  readonly message?: string;
  /** The Unix time, in seconds, of the next attempt when the attempt will be retried. */
  readonly nextRetryAtUtc?: number;

  /** The webhook retry-after hint, in milliseconds. */
  readonly retryAfterMs?: number;
  /** The webhook target host. */
  readonly targetUrlHost?: string;
  /** The webhook endpoint identifier. */
  readonly webhookRef?: string;
  /** The key ID used to sign the webhook attempt. */
  readonly signingKeyKid?: string;
  /** The raw-message token lifetime the webhook attempt used, in seconds. */
  readonly rawTokenTtlSeconds?: number;
}

/** A message the listener accepted. */
export interface AcceptedNotification {
  /** Always `accepted`. */
  readonly kind: typeof notificationKind.accepted;
  /**
   * The accepted-message payload. It is the same payload a
   * `DELIVER_WEBHOOK` delivery carries; download the raw message with
   * `fetchRawEmail` from `@mxraven/mail/webhook` when needed.
   */
  readonly accepted: InboundEmail;
}

/** One delivery attempt for an accepted message. */
export interface AttemptNotification {
  /** Always `attempt`. */
  readonly kind: typeof notificationKind.attempt;
  /** The attempt details. */
  readonly attempt: AttemptEvent;
}

/**
 * A decoded client notification.
 *
 * The `kind` field selects the payload shape. Both kinds arrive on one
 * listener's durable consumer.
 *
 * @public
 */
export type NotificationEvent = AcceptedNotification | AttemptNotification;
