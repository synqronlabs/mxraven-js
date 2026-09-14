/**
 * mxRaven webhook payload decoding.
 */

import {
  eventType,
  type DeliveryStatus,
  type Event,
  type InboundEmail,
  type StorageStatus,
} from "./payload.js";

/**
 * Decodes a webhook payload.
 *
 * Dispatching is based on the payload's `event_type` field. SMTP delivery
 * statuses do not carry an `event_type`, so a body with a `status` field and no
 * recognized event type is decoded as a delivery status.
 *
 * @param body - The raw JSON payload bytes, or a decoded string.
 * @returns The decoded event.
 * @throws `Error` When the body is not valid JSON or the payload is
 * unrecognized.
 *
 * @public
 */
export function decode(body: Uint8Array | string): Event {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("webhook: decode payload", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("webhook: unrecognized payload");
  }

  const probe = parsed as { event_type?: unknown; status?: unknown };
  switch (probe.event_type) {
    case eventType.inboundEmail:
      return { type: eventType.inboundEmail, inboundEmail: parsed as InboundEmail };
    case eventType.storageStatus:
      return { type: eventType.storageStatus, storageStatus: parsed as StorageStatus };
    default:
      if (probe.status !== undefined && probe.status !== null) {
        return { type: eventType.deliveryStatus, deliveryStatus: parsed as DeliveryStatus };
      }
      throw new Error(
        `webhook: unrecognized payload: event_type ${JSON.stringify(probe.event_type)}`,
      );
  }
}
