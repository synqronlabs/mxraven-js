/**
 * Decoding of notification subjects and bodies.
 *
 * @internal
 */

import type { InboundEmail, StatusOutcome } from "../webhook/payload.js";
import { DecodeError } from "./errors.js";
import {
  notificationKind,
  type AttemptChannel,
  type AttemptEvent,
  type NotificationEvent,
} from "./event.js";

type JsonObject = Record<string, unknown>;

/**
 * Decodes one notification body.
 *
 * The event kind is the final token of the subject. When the subject is
 * unavailable or unrecognized, the body shape is probed instead.
 *
 * @param subject - The subject the notification was published to.
 * @param body - The JSON body.
 * @returns The decoded notification.
 * @throws {@link DecodeError} When the body is not valid JSON, has a field of
 * the wrong type, or cannot be identified.
 *
 * @internal
 */
export function decodeNotification(subject: string, body: Uint8Array): NotificationEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (cause) {
    throw new DecodeError({ subject, cause });
  }
  const source = asObject(parsed, subject);

  switch (subjectKind(subject)) {
    case notificationKind.accepted:
      return decodeAccepted(source);
    case notificationKind.attempt:
      return decodeAttempt(source, subject);
  }

  if (source["event_type"] === "inbound_email") {
    return decodeAccepted(source);
  }
  if (typeof source["channel"] === "string" && source["channel"] !== "") {
    return decodeAttempt(source, subject);
  }
  throw new DecodeError({
    subject,
    cause: new Error("unrecognized notification body"),
  });
}

/** Returns the final subject token, which is the event kind. */
function subjectKind(subject: string): string {
  const trimmed = subject.trim();
  const index = trimmed.lastIndexOf(".");
  return index >= 0 ? trimmed.slice(index + 1).trim() : trimmed;
}

/**
 * Decodes an accepted-message body.
 *
 * The payload is the webhook inbound-email model, so it is reused verbatim.
 */
function decodeAccepted(source: JsonObject): NotificationEvent {
  return {
    kind: notificationKind.accepted,
    // The accepted payload is the same contract as the webhook payload, which
    // is decoded without per-field validation there. Keep the two consistent.
    accepted: source as unknown as InboundEmail,
  };
}

/** Decodes an attempt body and maps its wire snake_case fields to camelCase. */
function decodeAttempt(source: JsonObject, subject: string): NotificationEvent {
  const channel = requiredString(source, "channel", subject);
  const status = requiredString(source, "status", subject);

  const attempt: AttemptEvent = {
    eventType: optionalString(source, "event_type", subject),
    // The channel and status sets are open on the wire. A server that adds a
    // value before this SDK knows it still decodes; the value is preserved for
    // the caller rather than dropped.
    channel: channel as AttemptChannel,
    taskId: requiredString(source, "task_id", subject),
    tenantId: requiredString(source, "tenant_id", subject),
    listenerId: requiredString(source, "listener_id", subject),
    correlationId: optionalString(source, "correlation_id", subject),
    status: status as StatusOutcome,
    attempt: requiredNumber(source, "attempt", subject),
    acceptedAtUtc: optionalNumber(source, "accepted_at_utc", subject),
    occurredAtUtc: requiredNumber(source, "occurred_at_utc", subject),
    sourceIp: optionalString(source, "source_ip", subject),
    destinationDomain: optionalString(source, "destination_domain", subject),
    remoteHost: optionalString(source, "remote_host", subject),
    smtpCode: optionalNumber(source, "smtp_code", subject),
    enhancedStatusCode: optionalString(source, "enhanced_status_code", subject),
    reason: optionalString(source, "reason", subject),
    remoteResponse: optionalString(source, "remote_response", subject),
    correlationTaskId: optionalString(source, "correlation_task_id", subject),
    storageRef: optionalString(source, "storage_ref", subject),
    bucketName: optionalString(source, "bucket_name", subject),
    objectKey: optionalString(source, "object_key", subject),
    endpointHost: optionalString(source, "endpoint_host", subject),
    errorCode: optionalString(source, "error_code", subject),
    statusCode: optionalNumber(source, "status_code", subject),
    message: optionalString(source, "message", subject),
    nextRetryAtUtc: optionalNumber(source, "next_retry_at_utc", subject),
    retryAfterMs: optionalNumber(source, "retry_after_ms", subject),
    targetUrlHost: optionalString(source, "target_url_host", subject),
    webhookRef: optionalString(source, "webhook_ref", subject),
    signingKeyKid: optionalString(source, "signing_key_kid", subject),
    rawTokenTtlSeconds: optionalNumber(source, "raw_token_ttl_seconds", subject),
  };
  return { kind: notificationKind.attempt, attempt };
}

/** Narrows a parsed JSON value to an object, or reports a decode failure. */
function asObject(value: unknown, subject: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DecodeError({ subject, cause: new Error("body is not a JSON object") });
  }
  return value as JsonObject;
}

function requiredString(source: JsonObject, field: string, subject: string): string {
  const value = source[field];
  if (typeof value !== "string") {
    throw fieldTypeError(subject, field, "a string");
  }
  return value;
}

function optionalString(source: JsonObject, field: string, subject: string): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw fieldTypeError(subject, field, "a string");
  }
  return value;
}

function requiredNumber(source: JsonObject, field: string, subject: string): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw fieldTypeError(subject, field, "a number");
  }
  return value;
}

function optionalNumber(source: JsonObject, field: string, subject: string): number | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw fieldTypeError(subject, field, "a number");
  }
  return value;
}

function fieldTypeError(subject: string, field: string, want: string): DecodeError {
  return new DecodeError({
    subject,
    cause: new Error(`field ${JSON.stringify(field)} must be ${want}`),
  });
}
