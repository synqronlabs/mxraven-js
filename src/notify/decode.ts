/**
 * Decoding of notification subjects and bodies.
 *
 * @internal
 */

import type {
  AcceptedEnvelope,
  AcceptedMessage,
  HeaderField,
  MessageSummary,
  RawEmail,
  Verdicts,
} from "./accepted.js";
import { DecodeError } from "./errors.js";
import {
  notificationKind,
  type AcceptedNotification,
  type AttemptChannel,
  type AttemptEvent,
  type FaultEvent,
  type FaultNotification,
  type NotificationEvent,
  type StatusOutcome,
} from "./event.js";
import type {
  RoutingDecision,
  RoutingFault,
  RoutingHttpCall,
  RoutingIntent,
  RoutingIntentKind,
  RoutingSkip,
  TerminalAction,
} from "./routing.js";

type JsonObject = Record<string, unknown>;

/**
 * Decodes one notification body.
 *
 * The event kind is the final token of the subject. When the subject is
 * unavailable or unrecognized, the body is probed: an attempt carries a
 * `channel`, an accepted event carries a `routing_decision`, and a fault event
 * carries a top-level `fault`.
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
  const source = asObject(parsed, subject, "body");

  switch (subjectKind(subject)) {
    case notificationKind.accepted:
      return decodeAccepted(source, subject);
    case notificationKind.attempt:
      return decodeAttempt(source, subject);
    case notificationKind.fault:
      return decodeFaultEvent(source, subject);
  }

  if (typeof source["channel"] === "string" && source["channel"] !== "") {
    return decodeAttempt(source, subject);
  }
  if (source["routing_decision"] !== undefined && source["routing_decision"] !== null) {
    return decodeAccepted(source, subject);
  }
  if (source["fault"] !== undefined && source["fault"] !== null) {
    return decodeFaultEvent(source, subject);
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

/** Decodes an accepted-message body and its routing decision. */
function decodeAccepted(source: JsonObject, subject: string): AcceptedNotification {
  const accepted: AcceptedMessage = {
    taskId: requiredNonEmptyString(source, "task_id", subject),
    tenantId: requiredNonEmptyString(source, "tenant_id", subject),
    listenerId: requiredNonEmptyString(source, "listener_id", subject),
    messageRef: optionalString(source, "message_ref", subject),
    attempt: requiredPositiveNumber(source, "attempt", subject),
    acceptedAtUtc: requiredNumber(source, "accepted_at_utc", subject),
    occurredAtUtc: requiredNumber(source, "occurred_at_utc", subject),
    routingDecision: decodeRoutingDecision(
      requiredObject(source, "routing_decision", subject),
      subject,
    ),
    verdicts: decodeVerdicts(optionalObject(source, "verdicts", subject), subject),
    envelope: decodeEnvelope(requiredObject(source, "envelope", subject), subject),
    message: decodeMessageSummary(optionalObject(source, "message", subject), subject),
    headers: decodeHeaders(optionalArray(source, "headers", subject), subject),
    rawEmail: decodeRawEmail(optionalObject(source, "raw_email", subject), subject),
  };
  return { kind: notificationKind.accepted, accepted };
}

/** Decodes the routing decision and its nested effect audit records. */
function decodeRoutingDecision(source: JsonObject, subject: string): RoutingDecision {
  const revision = optionalNumber(source, "script_revision", subject);
  const fault = optionalObject(source, "fault", subject);

  return {
    terminalAction: requiredNonEmptyString(source, "terminal_action", subject) as TerminalAction,
    usedListenerDefault: requiredBoolean(source, "used_listener_default", subject),
    scriptRevisionId: optionalString(source, "script_revision_id", subject),
    // Revision numbers start at 1; the producer omits the field but decoders
    // that see a zero carry no revision information.
    scriptRevision: revision !== undefined && revision > 0 ? revision : undefined,
    intents: optionalArray(source, "intents", subject).map((item) => decodeIntent(item, subject)),
    skipped: optionalArray(source, "skipped", subject).map((item) => decodeSkip(item, subject)),
    log: optionalStringArray(source, "log", subject),
    fault: fault === undefined ? undefined : decodeRoutingFault(fault, subject),
    httpCalls:
      source["http_calls"] === undefined || source["http_calls"] === null
        ? undefined
        : optionalArray(source, "http_calls", subject).map((item) => decodeHttpCall(item, subject)),
  };
}

function decodeIntent(value: unknown, subject: string): RoutingIntent {
  const source = asObject(value, subject, "routing intent");
  return {
    kind: requiredNonEmptyString(source, "kind", subject) as RoutingIntentKind,
    header: optionalString(source, "header", subject),
    value: optionalString(source, "value", subject),
    address: optionalString(source, "address", subject),
    ref: optionalString(source, "ref", subject),
    pool: optionalString(source, "pool", subject),
    key: optionalString(source, "key", subject),
    template: optionalString(source, "template", subject),
    code: optionalNumber(source, "code", subject),
    enhanced: optionalString(source, "enhanced", subject),
    text: optionalString(source, "text", subject),
    reason: optionalString(source, "reason", subject),
  };
}

function decodeSkip(value: unknown, subject: string): RoutingSkip {
  const source = asObject(value, subject, "skipped intent");
  return {
    intent: decodeIntent(requiredObject(source, "intent", subject), subject),
    reason: requiredString(source, "reason", subject),
  };
}

function decodeRoutingFault(source: JsonObject, subject: string): RoutingFault {
  return {
    reason: requiredString(source, "reason", subject),
    message: requiredString(source, "message", subject),
    line: optionalNumber(source, "line", subject),
  };
}

function decodeHttpCall(value: unknown, subject: string): RoutingHttpCall {
  const source = asObject(value, subject, "http call");
  return {
    endpoint: requiredString(source, "endpoint", subject),
    status: requiredNumber(source, "status", subject),
    durationMs: requiredNumber(source, "duration_ms", subject),
    requestBytes: requiredNumber(source, "request_bytes", subject),
    responseBytes: requiredNumber(source, "response_bytes", subject),
    error: optionalString(source, "error", subject),
    cached: optionalBoolean(source, "cached", subject),
  };
}

function decodeVerdicts(source: JsonObject | undefined, subject: string): Verdicts | undefined {
  if (source === undefined) {
    return undefined;
  }
  return {
    action: requiredString(source, "action", subject),
    score: requiredNumber(source, "score", subject),
    requiredScore: requiredNumber(source, "required_score", subject),
    isSpam: requiredBoolean(source, "is_spam", subject),
    hasMalware: requiredBoolean(source, "has_malware", subject),
    malwareNames: optionalStringArray(source, "malware_names", subject),
    isSkipped: requiredBoolean(source, "is_skipped", subject),
    error: requiredString(source, "error", subject),
  };
}

function decodeEnvelope(source: JsonObject, subject: string): AcceptedEnvelope {
  return {
    mailFrom: requiredString(source, "mail_from", subject),
    rcptTo: optionalStringArray(source, "rcpt_to", subject),
  };
}

function decodeMessageSummary(source: JsonObject | undefined, subject: string): MessageSummary {
  if (source === undefined) {
    return {};
  }
  return {
    subject: optionalString(source, "subject", subject),
    from: optionalStringArrayOrUndefined(source, "from", subject),
    to: optionalStringArrayOrUndefined(source, "to", subject),
    cc: optionalStringArrayOrUndefined(source, "cc", subject),
    messageId: optionalString(source, "message_id", subject),
    date: optionalString(source, "date", subject),
  };
}

function decodeHeaders(values: readonly unknown[], subject: string): readonly HeaderField[] {
  return values.map((value) => {
    const source = asObject(value, subject, "header");
    return {
      name: requiredNonEmptyString(source, "name", subject),
      value: requiredString(source, "value", subject),
    };
  });
}

function decodeRawEmail(source: JsonObject | undefined, subject: string): RawEmail {
  if (source === undefined) {
    return { url: "", accessToken: "" };
  }
  return {
    url: optionalString(source, "url", subject) ?? "",
    tokenType: optionalString(source, "token_type", subject),
    accessToken: optionalString(source, "access_token", subject) ?? "",
    expiresAtUtc: optionalNumber(source, "expires_at_utc", subject),
    sizeBytes: optionalNumber(source, "size_bytes", subject),
    sha256Hex: optionalString(source, "sha256_hex", subject),
    contentType: optionalString(source, "content_type", subject),
  };
}

/** Decodes an attempt body and maps its wire snake_case fields to camelCase. */
function decodeAttempt(source: JsonObject, subject: string): NotificationEvent {
  const channel = requiredNonEmptyString(source, "channel", subject);
  const status = requiredNonEmptyString(source, "status", subject);

  const attempt: AttemptEvent = {
    // The channel and status sets are open on the wire. A server that adds a
    // value before this SDK knows it still decodes; the value is preserved for
    // the caller rather than dropped.
    channel: channel as AttemptChannel,
    taskId: requiredNonEmptyString(source, "task_id", subject),
    tenantId: requiredNonEmptyString(source, "tenant_id", subject),
    listenerId: requiredNonEmptyString(source, "listener_id", subject),
    messageRef: optionalString(source, "message_ref", subject),
    correlationId: optionalString(source, "correlation_id", subject),
    status: status as StatusOutcome,
    attempt: requiredPositiveNumber(source, "attempt", subject),
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
  };
  return { kind: notificationKind.attempt, attempt };
}

/** Decodes a sampled MTA routing-script fault event. */
function decodeFaultEvent(source: JsonObject, subject: string): FaultNotification {
  const fault: FaultEvent = {
    tenantId: requiredNonEmptyString(source, "tenant_id", subject),
    listenerId: requiredNonEmptyString(source, "listener_id", subject),
    messageRef: requiredNonEmptyString(source, "message_ref", subject),
    occurredAtUtc: requiredNumber(source, "occurred_at_utc", subject),
    scriptRevisionId: requiredString(source, "script_revision_id", subject),
    scriptRevision: requiredNumber(source, "script_revision", subject),
    mailFrom: requiredString(source, "mail_from", subject),
    recipient: requiredNonEmptyString(source, "recipient", subject),
    smtpResponse: requiredString(source, "smtp_response", subject),
    fault: decodeRoutingFault(requiredObject(source, "fault", subject), subject),
    log: requiredStringArray(source, "log", subject),
    httpCalls:
      source["http_calls"] === undefined || source["http_calls"] === null
        ? undefined
        : optionalArray(source, "http_calls", subject).map((item) => decodeHttpCall(item, subject)),
    suppressedFaults: requiredNumber(source, "suppressed_faults", subject),
  };
  return { kind: notificationKind.fault, fault };
}

/** Narrows a parsed JSON value to an object, or reports a decode failure. */
function asObject(value: unknown, subject: string, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fieldTypeError(subject, field, "an object");
  }
  return value as JsonObject;
}

function requiredObject(source: JsonObject, field: string, subject: string): JsonObject {
  const value = source[field];
  if (value === undefined || value === null) {
    throw fieldTypeError(subject, field, "an object");
  }
  return asObject(value, subject, field);
}

function optionalObject(
  source: JsonObject,
  field: string,
  subject: string,
): JsonObject | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  return asObject(value, subject, field);
}

function requiredString(source: JsonObject, field: string, subject: string): string {
  const value = source[field];
  if (typeof value !== "string") {
    throw fieldTypeError(subject, field, "a string");
  }
  return value;
}

function requiredNonEmptyString(source: JsonObject, field: string, subject: string): string {
  const value = requiredString(source, field, subject);
  if (value === "") {
    throw fieldTypeError(subject, field, "a non-empty string");
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

function requiredPositiveNumber(source: JsonObject, field: string, subject: string): number {
  const value = requiredNumber(source, field, subject);
  if (value <= 0) {
    throw fieldTypeError(subject, field, "a positive number");
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

function requiredBoolean(source: JsonObject, field: string, subject: string): boolean {
  const value = source[field];
  if (typeof value !== "boolean") {
    throw fieldTypeError(subject, field, "a boolean");
  }
  return value;
}

function optionalBoolean(source: JsonObject, field: string, subject: string): boolean | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw fieldTypeError(subject, field, "a boolean");
  }
  return value;
}

function optionalArray(source: JsonObject, field: string, subject: string): readonly unknown[] {
  const value = source[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw fieldTypeError(subject, field, "an array");
  }
  return value;
}

function optionalStringArray(
  source: JsonObject,
  field: string,
  subject: string,
): readonly string[] {
  return stringArray(optionalArray(source, field, subject), subject, field);
}

function requiredStringArray(
  source: JsonObject,
  field: string,
  subject: string,
): readonly string[] {
  const value = source[field];
  if (!Array.isArray(value)) {
    throw fieldTypeError(subject, field, "an array");
  }
  return stringArray(value, subject, field);
}

function optionalStringArrayOrUndefined(
  source: JsonObject,
  field: string,
  subject: string,
): readonly string[] | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw fieldTypeError(subject, field, "an array");
  }
  return stringArray(value, subject, field);
}

function stringArray(value: readonly unknown[], subject: string, field: string): readonly string[] {
  return value.map((item) => {
    if (typeof item !== "string") {
      throw fieldTypeError(subject, field, "an array of strings");
    }
    return item;
  });
}

function fieldTypeError(subject: string, field: string, want: string): DecodeError {
  return new DecodeError({
    subject,
    cause: new Error(`field ${JSON.stringify(field)} must be ${want}`),
  });
}
