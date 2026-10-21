/**
 * Notification body decoding tests.
 */

import { describe, expect, it } from "vitest";

import { statusOutcome } from "../webhook/payload.js";
import { decodeNotification } from "./decode.js";
import { DecodeError } from "./errors.js";
import { attemptChannel, notificationKind } from "./event.js";

const acceptedBody = `{
  "event_type": "inbound_email",
  "task_id": "task-1",
  "tenant_id": "tenant-1",
  "listener_id": "listener-1",
  "attempt": 1,
  "accepted_at_utc": 1700000000,
  "occurred_at_utc": 1700000001,
  "routing_decision": {"terminal_action": "TERMINAL_ACTION_TYPE_DELIVER_WEBHOOK", "used_listener_default": false},
  "verdicts": {"action": "accept", "score": 0, "required_score": 5, "is_spam": false, "has_malware": false, "malware_names": [], "is_skipped": true, "error": ""},
  "envelope": {"mail_from": "sender@example.com", "rcpt_to": ["rcpt@example.com"]},
  "message": {"subject": "hi", "message_id": "<1@example.com>"},
  "headers": [{"name": "Subject", "value": "hi"}],
  "raw_email": {
    "url": "https://raw.example/messages/task-1.eml",
    "token_type": "Bearer",
    "access_token": "secret-token",
    "expires_at_utc": 1700100000,
    "size_bytes": 12,
    "sha256_hex": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    "content_type": "text/plain"
  }
}`;

const smtpAttemptBody = `{
  "channel": "smtp",
  "task_id": "task-1",
  "tenant_id": "tenant-1",
  "listener_id": "listener-1",
  "message_ref": "message-ref-1",
  "correlation_id": "accepted-1",
  "status": "deferred",
  "attempt": 3,
  "accepted_at_utc": 1700000000,
  "occurred_at_utc": 1700000001,
  "source_ip": "192.0.2.1",
  "destination_domain": "example.com",
  "remote_host": "mx.example.com",
  "smtp_code": 451,
  "enhanced_status_code": "4.7.1",
  "reason": "smtp_transient",
  "remote_response": "try later",
  "next_retry_at_utc": 1700000060,
  "correlation_task_id": "corr-1"
}`;

const s3AttemptBody = `{
  "event_type": "s3_egress_status",
  "channel": "s3",
  "task_id": "task-1",
  "tenant_id": "tenant-1",
  "listener_id": "listener-1",
  "message_ref": "message-ref-1",
  "correlation_id": "accepted-1",
  "status": "delivered",
  "attempt": 2,
  "accepted_at_utc": 1700000000,
  "occurred_at_utc": 1700000001,
  "storage_ref": "storage-1",
  "bucket_name": "bucket",
  "object_key": "inbound/a.eml",
  "endpoint_host": "s3.example.com",
  "status_code": 200
}`;

const webhookAttemptBody = `{
  "event_type": "webhook_egress_status",
  "channel": "webhook",
  "task_id": "task-1",
  "tenant_id": "tenant-1",
  "listener_id": "listener-1",
  "message_ref": "message-ref-1",
  "correlation_id": "accepted-1",
  "status": "invalid",
  "attempt": 1,
  "status_code": 500,
  "message": "boom",
  "retry_after_ms": 1000,
  "occurred_at_utc": 1700000001,
  "target_url_host": "hooks.example.com",
  "webhook_ref": "hook-1",
  "signing_key_kid": "kid-1",
  "raw_token_ttl_seconds": 90000
}`;

describe("decodeNotification", () => {
  it("decodes an accepted event as the webhook inbound-email payload", () => {
    const subject = "tenant.tenant-1.listener.listener-1.events.accepted";
    const event = decodeNotification(subject, Buffer.from(acceptedBody));

    expect(event.kind).toBe(notificationKind.accepted);
    if (event.kind !== notificationKind.accepted) {
      throw new Error("expected an accepted event");
    }
    // The accepted payload is shared with the webhook model; decoding must not
    // drop, rename, or reshape any field.
    expect(event.accepted).toEqual(JSON.parse(acceptedBody));
    expect(event.accepted.raw_email.access_token).toBe("secret-token");
  });

  it.each([
    ["smtp", smtpAttemptBody, attemptChannel.smtp, statusOutcome.deferred],
    ["s3", s3AttemptBody, attemptChannel.s3, statusOutcome.delivered],
    ["webhook", webhookAttemptBody, attemptChannel.webhook, statusOutcome.invalid],
  ])("decodes a %s attempt event", (_name, body, channel, status) => {
    const subject = "tenant.tenant-1.listener.listener-1.events.attempt";
    const event = decodeNotification(subject, Buffer.from(body));

    expect(event.kind).toBe(notificationKind.attempt);
    if (event.kind !== notificationKind.attempt) {
      throw new Error("expected an attempt event");
    }
    expect(event.attempt.channel).toBe(channel);
    expect(event.attempt.status).toBe(status);
    expect(event.attempt.correlationId).toBe("accepted-1");
    expect(event.attempt.messageRef).toBe("message-ref-1");
  });

  it("maps every SMTP attempt field to camelCase", () => {
    const event = decodeNotification("x.events.attempt", Buffer.from(smtpAttemptBody));
    if (event.kind !== notificationKind.attempt) {
      throw new Error("expected an attempt event");
    }

    expect(event.attempt).toEqual({
      channel: "smtp",
      taskId: "task-1",
      tenantId: "tenant-1",
      listenerId: "listener-1",
      messageRef: "message-ref-1",
      correlationId: "accepted-1",
      status: "deferred",
      attempt: 3,
      acceptedAtUtc: 1700000000,
      occurredAtUtc: 1700000001,
      sourceIp: "192.0.2.1",
      destinationDomain: "example.com",
      remoteHost: "mx.example.com",
      smtpCode: 451,
      enhancedStatusCode: "4.7.1",
      reason: "smtp_transient",
      remoteResponse: "try later",
      nextRetryAtUtc: 1700000060,
      correlationTaskId: "corr-1",
    });
  });

  it("maps every webhook attempt field to camelCase", () => {
    const event = decodeNotification("x.events.attempt", Buffer.from(webhookAttemptBody));
    if (event.kind !== notificationKind.attempt) {
      throw new Error("expected an attempt event");
    }

    expect(event.attempt).toMatchObject({
      eventType: "webhook_egress_status",
      channel: "webhook",
      status: "invalid",
      statusCode: 500,
      message: "boom",
      retryAfterMs: 1000,
      targetUrlHost: "hooks.example.com",
      webhookRef: "hook-1",
      signingKeyKid: "kid-1",
      rawTokenTtlSeconds: 90000,
    });
  });

  it.each([
    ["accepted", acceptedBody],
    ["attempt", s3AttemptBody],
  ])("falls back to the %s body shape", (_name, body) => {
    expect(() => decodeNotification("", Buffer.from(body))).not.toThrow();
    expect(() => decodeNotification("unknown", Buffer.from(body))).not.toThrow();
  });

  it("reports invalid JSON with the subject", () => {
    let thrown: unknown;
    try {
      decodeNotification("x.events.accepted", Buffer.from("{"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DecodeError);
    const decodeError = thrown as DecodeError;
    expect(decodeError.subject).toBe("x.events.accepted");
    expect(decodeError.cause).toBeInstanceOf(Error);
  });

  it("reports an unrecognized body", () => {
    expect(() =>
      decodeNotification("x.events.unknown", Buffer.from(JSON.stringify({ foo: "bar" }))),
    ).toThrow(DecodeError);
  });

  it("reports a field with the wrong type", () => {
    const body = JSON.stringify({
      channel: "smtp",
      task_id: "task-1",
      tenant_id: "tenant-1",
      listener_id: "listener-1",
      status: "delivered",
      attempt: "one",
      occurred_at_utc: 1700000001,
    });
    expect(() => decodeNotification("x.events.attempt", Buffer.from(body))).toThrow(DecodeError);
  });
});
