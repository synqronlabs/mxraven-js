/**
 * Webhook payload decoding tests for status shapes emitted by the runtime.
 */

import { describe, expect, it } from "vitest";

import { decode } from "./decode.js";
import { eventType, statusOutcome } from "./payload.js";

describe("decode delivery statuses", () => {
  it("decodes the SMTP reason classification", () => {
    const event = decode(
      JSON.stringify({
        task_id: "task-1",
        tenant_id: "tenant-1",
        listener_id: "listener-1",
        status: "deferred",
        attempt: 2,
        accepted_at_utc: 1700000000,
        occurred_at_utc: 1700000001,
        reason: "smtp_transient",
      }),
    );

    expect(event.type).toBe(eventType.deliveryStatus);
    if (event.type !== eventType.deliveryStatus) {
      throw new Error("expected a delivery status");
    }
    expect(event.deliveryStatus.reason).toBe("smtp_transient");
  });

  it("decodes an invalid webhook egress status", () => {
    const event = decode(
      JSON.stringify({
        event_type: "webhook_egress_status",
        channel: "webhook",
        task_id: "task-1",
        status: "invalid",
        attempt: 1,
        occurred_at_utc: 1700000001,
        status_code: 0,
      }),
    );

    expect(event.type).toBe(eventType.deliveryStatus);
    if (event.type !== eventType.deliveryStatus) {
      throw new Error("expected a delivery status");
    }
    expect(event.deliveryStatus.status).toBe(statusOutcome.invalid);
  });
});
