/**
 * Decoded client notification payload shapes.
 */

import type { AcceptedMessage } from "./accepted.js";
import type { RoutingFault, RoutingHttpCall } from "./routing.js";

/** Identifies which kind of notification an event carries. @public */
export const notificationKind = {
  /** A message the listener accepted and whose routing decision was resolved. */
  accepted: "accepted",
  /** One delivery attempt for an accepted message on an egress channel. */
  attempt: "attempt",
  /** An MTA listener's routing script faulted and the message was deferred. */
  fault: "fault",
} as const;

/** Identifies which kind of notification an event carries. @public */
export type NotificationKind = (typeof notificationKind)[keyof typeof notificationKind];

/**
 * The lifecycle state reported for a delivery attempt.
 *
 * Not every channel reports every value: an SMTP attempt can report
 * `suppressed`, and an object-storage attempt reports only the first five.
 *
 * @public
 */
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
  /** Delivery was skipped by a suppression rule. SMTP attempts only. */
  suppressed: "suppressed",
} as const;

/** The lifecycle state reported for a delivery attempt. @public */
export type StatusOutcome = (typeof statusOutcome)[keyof typeof statusOutcome];

/** Identifies the egress worker that produced an attempt event. @public */
export const attemptChannel = {
  /** An SMTP delivery attempt. */
  smtp: "smtp",
  /** An object-storage write attempt. */
  s3: "s3",
} as const;

/** Identifies the egress worker that produced an attempt event. @public */
export type AttemptChannel = (typeof attemptChannel)[keyof typeof attemptChannel];

/**
 * One delivery attempt for an accepted message.
 *
 * `channel` names the worker that produced the event. The remaining fields
 * describe that channel's protocol and are absent when they do not apply.
 *
 * A routing script that stages several effects reports each one, so an inbound
 * message whose script forwards and archives produces an attempt event for
 * each. Every attempt carries a `correlationId` that points at the `taskId` of
 * the accepted event for the message it stems from, which is how an attempt
 * joins back to its acceptance. A submission listener's attempts usually share
 * the accepted event's `taskId` as well.
 *
 * @public
 */
export interface AttemptEvent {
  /** The egress worker that produced the attempt. */
  readonly channel: AttemptChannel;
  /** The delivery task. For a submission listener this equals the accepted event's `taskId`. */
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
  /** The `taskId` of the accepted event for the message, when one was recorded. */
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

  /** The storage HTTP response status for an `s3` attempt. */
  readonly statusCode?: number;
  /** The failure description, truncated by the server. */
  readonly message?: string;
  /** The Unix time, in seconds, of the next attempt when the attempt will be retried. */
  readonly nextRetryAtUtc?: number;
}

/**
 * An MTA listener's routing-script fault.
 *
 * A fault now defers the transaction with a `451 4.3.0` reply, so no accepted
 * event exists to carry it. This event is how the tenant learns why the message
 * was not accepted.
 *
 * Fault events are sampled: each `smtp-mta` replica publishes at most one per
 * script revision per minute. `suppressedFaults` counts the same revision's
 * faults the replica did not report since its previous event, so one sample
 * explains a broken revision without flooding the stream.
 *
 * @public
 */
export interface FaultEvent {
  /** The owning tenant. */
  readonly tenantId: string;
  /** The MTA listener whose script faulted. */
  readonly listenerId: string;
  /** The mxRaven message reference of the deferred transaction. */
  readonly messageRef: string;
  /** The Unix time, in seconds, when the fault was reported. */
  readonly occurredAtUtc: number;
  /** The published script revision that faulted. */
  readonly scriptRevisionId: string;
  /** The revision number that faulted. */
  readonly scriptRevision: number;
  /** The envelope sender. It may be empty for a null reverse-path. */
  readonly mailFrom: string;
  /** The recipient context whose routing faulted. */
  readonly recipient: string;
  /** The reply the sender received, for example a `451 4.3.0` deferral. */
  readonly smtpResponse: string;
  /** The stable fault reason, message, and script line. */
  readonly fault: RoutingFault;
  /** The script's `mx.log` lines, in order. */
  readonly log: readonly string[];
  /** Every `mx.http` call the invocation made. At most two. */
  readonly httpCalls?: readonly RoutingHttpCall[];
  /**
   * Same-revision faults the producer did not report since its previous fault
   * event.
   */
  readonly suppressedFaults: number;
}

/** A message the listener accepted. @public */
export interface AcceptedNotification {
  /** Always `accepted`. */
  readonly kind: typeof notificationKind.accepted;
  /** The accepted-message payload and its routing decision. */
  readonly accepted: AcceptedMessage;
}

/** One delivery attempt for an accepted message. @public */
export interface AttemptNotification {
  /** Always `attempt`. */
  readonly kind: typeof notificationKind.attempt;
  /** The attempt details. */
  readonly attempt: AttemptEvent;
}

/** A sampled routing-script fault for an MTA listener. @public */
export interface FaultNotification {
  /** Always `fault`. */
  readonly kind: typeof notificationKind.fault;
  /** The fault details. */
  readonly fault: FaultEvent;
}

/**
 * A decoded client notification.
 *
 * The `kind` field selects the payload shape. Every kind arrives on one
 * listener's durable consumer.
 *
 * @public
 */
export type NotificationEvent = AcceptedNotification | AttemptNotification | FaultNotification;
