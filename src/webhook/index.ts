/**
 * Webhook verification and decoding for mxRaven deliveries.
 *
 * mxRaven signs every webhook delivery with HMAC-SHA256 over a canonical
 * request string and sends the signature in `X-MxRaven-*` headers. A server
 * that exposes a webhook endpoint verifies the request with a {@link Verifier}
 * and decodes the JSON body:
 *
 * ```ts
 * const secret = process.env.MXRAVEN_WEBHOOK_SECRET;
 * if (secret === undefined || secret === "") {
 *   throw new Error("MXRAVEN_WEBHOOK_SECRET is required");
 * }
 *
 * const verifier = new Verifier({ secret });
 *
 * const event = await verifier.verifyAndDecode(request);
 * switch (event.type) {
 *   case eventType.inboundEmail:
 *     // A full inbound message.
 *     break;
 *   case eventType.deliveryStatus:
 *     // An SMTP delivery status.
 *     break;
 *   case eventType.storageStatus:
 *     // An object-storage delivery status.
 *     break;
 * }
 * ```
 *
 * The signing secret is shown only once, when the webhook endpoint is created
 * or its secret is rotated. The secret is used as literal key bytes; do not
 * base64-decode it.
 *
 * @packageDocumentation
 */

export { decode } from "./decode.js";
export { InvalidSignatureError } from "./errors.js";
export { eventType, statusOutcome, terminalAction } from "./payload.js";
export type {
  DeliveryStatus,
  Event,
  EventType,
  HeaderField,
  InboundEmail,
  MessageSummary,
  RawEmail,
  RoutingDecision,
  StatusOutcome,
  StorageStatus,
  TerminalAction,
  Verdicts,
  WebhookEnvelope,
} from "./payload.js";
export { fetchRawEmail } from "./raw.js";
export type { FetchLike, FetchRawEmailOptions } from "./raw.js";
export { Verifier, webhookHeaders } from "./verifier.js";
export type { VerifierOptions, VerifyOptions } from "./verifier.js";
