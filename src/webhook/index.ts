/**
 * Webhook verification, dispatch, and decoding for mxRaven deliveries.
 *
 * mxRaven signs every webhook delivery with HMAC-SHA256 over a canonical
 * request string and sends the signature in `X-MxRaven-*` headers. The
 * recommended entry point is {@link WebhookHandler}, which verifies the
 * request, decodes the JSON payload, and dispatches it to typed listeners:
 *
 * ```ts
 * const webhook = new WebhookHandler({ secret });
 *
 * webhook.on(eventType.inboundEmail, async (email) => {
 *   await store.save(email.task_id, email);
 * });
 *
 * export default { fetch: (request: Request) => webhook.handle(request) };
 * ```
 *
 * Listeners run in registration order and the request is only acknowledged
 * after they resolve. `handle` never throws for protocol failures; the
 * response status is `204` accepted, `400` malformed, `401` bad signature,
 * `413` body too large, or `500` when a listener throws, which makes mxRaven
 * retry. For Node frameworks that do not expose a Fetch `Request`, pass
 * `method`, `url`, `headers`, and `body` to `handle` instead.
 *
 * An inbound-email event carries the message metadata, the decoded header
 * summary, every header, and a `raw_email` **reference**. The body and
 * attachments are not inlined; download and parse them with
 * `fetchAndParseRawEmail` from `@mxraven/mail/mime` when needed.
 *
 * For full control, use the low-level {@link Verifier} and {@link decode}:
 * verify a request, then switch on `event.type`.
 *
 * The signing secret is shown only once, when the webhook endpoint is created
 * or its secret is rotated. The secret is used as literal key bytes; do not
 * base64-decode it.
 *
 * @packageDocumentation
 */

export { decode } from "./decode.js";
export {
  InvalidSignatureError,
  PayloadTooLargeError,
  WebhookError,
  WebhookRequestError,
} from "./errors.js";
export type { WebhookStatus } from "./errors.js";
export { WebhookHandler } from "./handler.js";
export type {
  DeliveryStatusHandler,
  InboundEmailHandler,
  StorageStatusHandler,
  WebhookEventHandlers,
  WebhookHandlerOptions,
  WebhookRequestParts,
} from "./handler.js";
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
