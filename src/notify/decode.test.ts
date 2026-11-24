/**
 * Notification body decoding tests.
 */

import { describe, expect, it } from "vitest";

import { decodeNotification } from "./decode.js";
import { DecodeError } from "./errors.js";
import { attemptChannel, notificationKind, statusOutcome } from "./event.js";
import { routingIntentKind, terminalAction } from "./routing.js";

const acceptedBody = `{
  "task_id": "task-1",
  "tenant_id": "tenant-1",
  "listener_id": "listener-1",
  "message_ref": "message-ref-1",
  "attempt": 1,
  "accepted_at_utc": 1700000000,
  "occurred_at_utc": 1700000001,
  "routing_decision": {
    "terminal_action": "TERMINAL_ACTION_TYPE_DELIVER",
    "used_listener_default": false,
    "script_revision_id": "rev-1",
    "script_revision": 3,
    "intents": [
      {"kind": "header.set", "header": "X-Seen", "value": "1"},
      {"kind": "header.remove", "header": "X-Originating-IP"}
    ],
    "skipped": [
      {"intent": {"kind": "forward.smtp", "ref": "unverified"}, "reason": "destination is not verified"}
    ],
    "log": ["hello from the script"],
    "http_calls": [
      {"endpoint": "risk-check", "status": 200, "duration_ms": 12, "request_bytes": 30, "response_bytes": 10, "cached": true}
    ]
  },
  "verdicts": {
    "action": "accept",
    "score": 0,
    "required_score": 5,
    "is_spam": false,
    "has_malware": false,
    "malware_names": [],
    "is_skipped": true,
    "error": ""
  },
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

const faultBody = `{
  "tenant_id": "tenant-1",
  "listener_id": "listener-1",
  "message_ref": "message-ref-1",
  "occurred_at_utc": 1700000001,
  "script_revision_id": "rev-3",
  "script_revision": 3,
  "mail_from": "sender@example.com",
  "recipient": "rcpt@example.com",
  "smtp_response": "451 4.3.0 temporarily unable to accept this message; try again later",
  "fault": {"reason": "runtime_error", "message": "boom", "line": 4},
  "log": ["start"],
  "http_calls": [
    {"endpoint": "risk-check", "status": 200, "duration_ms": 12, "request_bytes": 64, "response_bytes": 8}
  ],
  "suppressed_faults": 7
}`;

describe("decodeNotification", () => {
  it("decodes and maps an accepted event", () => {
    const subject = "tenant.tenant-1.listener.listener-1.events.accepted";
    const event = decodeNotification(subject, Buffer.from(acceptedBody));

    expect(event.kind).toBe(notificationKind.accepted);
    if (event.kind !== notificationKind.accepted) {
      throw new Error("expected an accepted event");
    }
    expect(event.accepted).toEqual({
      taskId: "task-1",
      tenantId: "tenant-1",
      listenerId: "listener-1",
      messageRef: "message-ref-1",
      attempt: 1,
      acceptedAtUtc: 1700000000,
      occurredAtUtc: 1700000001,
      routingDecision: {
        terminalAction: terminalAction.deliver,
        usedListenerDefault: false,
        scriptRevisionId: "rev-1",
        scriptRevision: 3,
        intents: [
          { kind: routingIntentKind.headerSet, header: "X-Seen", value: "1" },
          { kind: routingIntentKind.headerRemove, header: "X-Originating-IP" },
        ],
        skipped: [
          {
            intent: { kind: routingIntentKind.forwardSmtp, ref: "unverified" },
            reason: "destination is not verified",
          },
        ],
        log: ["hello from the script"],
        httpCalls: [
          {
            endpoint: "risk-check",
            status: 200,
            durationMs: 12,
            requestBytes: 30,
            responseBytes: 10,
            cached: true,
          },
        ],
      },
      verdicts: {
        action: "accept",
        score: 0,
        requiredScore: 5,
        isSpam: false,
        hasMalware: false,
        malwareNames: [],
        isSkipped: true,
        error: "",
      },
      envelope: { mailFrom: "sender@example.com", rcptTo: ["rcpt@example.com"] },
      message: { subject: "hi", messageId: "<1@example.com>" },
      headers: [{ name: "Subject", value: "hi" }],
      rawEmail: {
        url: "https://raw.example/messages/task-1.eml",
        tokenType: "Bearer",
        accessToken: "secret-token",
        expiresAtUtc: 1700100000,
        sizeBytes: 12,
        sha256Hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        contentType: "text/plain",
      },
    });
  });

  it("defaults the routing arrays and drops a zero revision", () => {
    const body = JSON.stringify({
      task_id: "task-1",
      tenant_id: "tenant-1",
      listener_id: "listener-1",
      attempt: 1,
      accepted_at_utc: 1700000000,
      occurred_at_utc: 1700000001,
      routing_decision: {
        terminal_action: "TERMINAL_ACTION_TYPE_DELIVER",
        used_listener_default: true,
        script_revision: 0,
        log: [],
      },
      envelope: { mail_from: "sender@example.com", rcpt_to: [] },
      raw_email: {
        url: "",
        token_type: "",
        access_token: "",
        expires_at_utc: 0,
        size_bytes: 0,
        sha256_hex: "",
      },
    });

    const event = decodeNotification("x.events.accepted", Buffer.from(body));
    if (event.kind !== notificationKind.accepted) {
      throw new Error("expected an accepted event");
    }
    expect(event.accepted.routingDecision).toEqual({
      terminalAction: terminalAction.deliver,
      usedListenerDefault: true,
      scriptRevisionId: undefined,
      scriptRevision: undefined,
      intents: [],
      skipped: [],
      log: [],
      fault: undefined,
      httpCalls: undefined,
    });
    expect(event.accepted.message).toEqual({});
    expect(event.accepted.headers).toEqual([]);
    expect(event.accepted.rawEmail.accessToken).toBe("");
  });

  it("decodes a routing fault", () => {
    const body = JSON.stringify({
      task_id: "task-1",
      tenant_id: "tenant-1",
      listener_id: "listener-1",
      attempt: 1,
      accepted_at_utc: 1700000000,
      occurred_at_utc: 1700000001,
      routing_decision: {
        terminal_action: "TERMINAL_ACTION_TYPE_DROP",
        used_listener_default: true,
        intents: [],
        log: ["script fault at line 4"],
        fault: { reason: "quarantined", message: "too many faults", line: 4 },
      },
      envelope: { mail_from: "", rcpt_to: ["rcpt@example.com"] },
      raw_email: { url: "", access_token: "" },
    });

    const event = decodeNotification("x.events.accepted", Buffer.from(body));
    if (event.kind !== notificationKind.accepted) {
      throw new Error("expected an accepted event");
    }
    expect(event.accepted.routingDecision.fault).toEqual({
      reason: "quarantined",
      message: "too many faults",
      line: 4,
    });
  });

  it.each([
    ["smtp", smtpAttemptBody, attemptChannel.smtp, statusOutcome.deferred],
    ["s3", s3AttemptBody, attemptChannel.s3, statusOutcome.delivered],
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

  it("maps every s3 attempt field to camelCase", () => {
    const event = decodeNotification("x.events.attempt", Buffer.from(s3AttemptBody));
    if (event.kind !== notificationKind.attempt) {
      throw new Error("expected an attempt event");
    }

    expect(event.attempt).toMatchObject({
      channel: "s3",
      status: "delivered",
      storageRef: "storage-1",
      bucketName: "bucket",
      objectKey: "inbound/a.eml",
      endpointHost: "s3.example.com",
      statusCode: 200,
    });
  });

  it("decodes a sampled routing fault event", () => {
    const event = decodeNotification(
      "tenant.tenant-1.listener.listener-1.events.fault",
      Buffer.from(faultBody),
    );

    expect(event.kind).toBe(notificationKind.fault);
    if (event.kind !== notificationKind.fault) {
      throw new Error("expected a fault event");
    }
    expect(event.fault).toEqual({
      tenantId: "tenant-1",
      listenerId: "listener-1",
      messageRef: "message-ref-1",
      occurredAtUtc: 1700000001,
      scriptRevisionId: "rev-3",
      scriptRevision: 3,
      mailFrom: "sender@example.com",
      recipient: "rcpt@example.com",
      smtpResponse: "451 4.3.0 temporarily unable to accept this message; try again later",
      fault: { reason: "runtime_error", message: "boom", line: 4 },
      log: ["start"],
      httpCalls: [
        {
          endpoint: "risk-check",
          status: 200,
          durationMs: 12,
          requestBytes: 64,
          responseBytes: 8,
        },
      ],
      suppressedFaults: 7,
    });
  });

  it("leaves fault http_calls absent when the producer omits them", () => {
    const body = JSON.stringify({
      tenant_id: "tenant-1",
      listener_id: "listener-1",
      message_ref: "message-ref-1",
      occurred_at_utc: 1700000001,
      script_revision_id: "rev-3",
      script_revision: 3,
      mail_from: "",
      recipient: "rcpt@example.com",
      smtp_response: "451 4.3.0 try again",
      fault: { reason: "quarantined", message: "held" },
      log: [],
      suppressed_faults: 0,
    });

    const event = decodeNotification("x.events.fault", Buffer.from(body));
    if (event.kind !== notificationKind.fault) {
      throw new Error("expected a fault event");
    }
    expect(event.fault.httpCalls).toBeUndefined();
  });

  it.each([
    ["accepted", acceptedBody],
    ["attempt", s3AttemptBody],
    ["fault", faultBody],
  ])("falls back to the %s body shape", (_name, body) => {
    expect(() => decodeNotification("", Buffer.from(body))).not.toThrow();
    expect(() => decodeNotification("unknown", Buffer.from(body))).not.toThrow();
  });

  it.each([
    ["accepted", acceptedBody, "inbound_email"],
    ["attempt", s3AttemptBody, "s3_egress_status"],
  ])("ignores the removed event_type field on an in-flight %s event", (_name, body, legacyType) => {
    const parsed: Record<string, unknown> = JSON.parse(body);
    const event = decodeNotification(
      `tenant.t.listener.l.events.${_name}`,
      Buffer.from(JSON.stringify({ ...parsed, event_type: legacyType })),
    );
    expect(event.kind).toBe(_name);
  });

  it.each([
    [
      "accepted without a routing decision",
      "x.events.accepted",
      `{"task_id":"task-1","tenant_id":"tenant-1","listener_id":"listener-1","attempt":1,"accepted_at_utc":1,"occurred_at_utc":2,"envelope":{"mail_from":""}}`,
    ],
    [
      "accepted without a terminal action",
      "x.events.accepted",
      `{"task_id":"task-1","tenant_id":"tenant-1","listener_id":"listener-1","attempt":1,"accepted_at_utc":1,"occurred_at_utc":2,"routing_decision":{"used_listener_default":false},"envelope":{"mail_from":""}}`,
    ],
    [
      "accepted with an empty task ID",
      "x.events.accepted",
      `{"task_id":"","tenant_id":"tenant-1","listener_id":"listener-1","attempt":1,"accepted_at_utc":1,"occurred_at_utc":2,"routing_decision":{"terminal_action":"TERMINAL_ACTION_TYPE_DELIVER","used_listener_default":false},"envelope":{"mail_from":""}}`,
    ],
    [
      "attempt without a channel",
      "x.events.attempt",
      `{"task_id":"task-1","tenant_id":"tenant-1","listener_id":"listener-1","status":"delivered","attempt":1,"occurred_at_utc":2}`,
    ],
    [
      "attempt without a status",
      "x.events.attempt",
      `{"channel":"smtp","task_id":"task-1","tenant_id":"tenant-1","listener_id":"listener-1","attempt":1,"occurred_at_utc":2}`,
    ],
    [
      "attempt with a zero attempt number",
      "x.events.attempt",
      `{"channel":"smtp","task_id":"task-1","tenant_id":"tenant-1","listener_id":"listener-1","status":"delivered","attempt":0,"occurred_at_utc":2}`,
    ],
    [
      "fault without a fault",
      "x.events.fault",
      `{"tenant_id":"tenant-1","listener_id":"listener-1","message_ref":"ref","occurred_at_utc":2,"script_revision_id":"rev","script_revision":1,"mail_from":"","recipient":"r@example.com","smtp_response":"451","log":[],"suppressed_faults":0}`,
    ],
    [
      "fault with an empty recipient",
      "x.events.fault",
      `{"tenant_id":"tenant-1","listener_id":"listener-1","message_ref":"ref","occurred_at_utc":2,"script_revision_id":"rev","script_revision":1,"mail_from":"","recipient":"","smtp_response":"451","fault":{"reason":"runtime_error","message":"boom"},"log":[],"suppressed_faults":0}`,
    ],
  ])("rejects %s", (_name, subject, body) => {
    expect(() => decodeNotification(subject, Buffer.from(body))).toThrow(DecodeError);
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

  it("reports a malformed routing intent", () => {
    const body = JSON.stringify({
      task_id: "task-1",
      tenant_id: "tenant-1",
      listener_id: "listener-1",
      attempt: 1,
      accepted_at_utc: 1700000000,
      occurred_at_utc: 1700000001,
      routing_decision: {
        terminal_action: "TERMINAL_ACTION_TYPE_DELIVER",
        used_listener_default: false,
        intents: [{ kind: 42 }],
        log: [],
      },
      envelope: { mail_from: "", rcpt_to: [] },
      raw_email: { url: "", access_token: "" },
    });
    expect(() => decodeNotification("x.events.accepted", Buffer.from(body))).toThrow(DecodeError);
  });
});
