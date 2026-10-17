/**
 * Client notification events over NATS JetStream.
 *
 * When notifications are enabled for a listener, mxRaven publishes every
 * accepted message and every delivery attempt to that listener's durable
 * JetStream consumer. This entry point consumes those events with the
 * listener's ordinary API key:
 *
 * ```ts
 * import { NotificationClient } from "@mxraven/mail/notify";
 *
 * const client = await NotificationClient.connect({
 *   url: "wss://nats.mxraven.com",
 *   username: "mxr_tx_ab12cd34ef56",
 *   secret: process.env.MXRAVEN_SECRET!,
 *   listener: listenerId,
 * });
 *
 * await client.consume((event) => {
 *   if (event.kind === "accepted") {
 *     console.log(event.accepted.task_id);
 *   } else {
 *     console.log(event.attempt.taskId, event.attempt.status);
 *   }
 * });
 * ```
 *
 * `consume` acknowledges an event when its handler returns normally,
 * redelivers it with exponential backoff when the handler throws, and stops
 * when the handler returns {@link stopConsuming}. {@link NotificationClient.events}
 * is the lower-level async iterator for callers that acknowledge each event
 * themselves.
 *
 * Accepted events reuse the webhook payload model, {@link InboundEmail}; an MTA
 * listener's accepted event carries raw-message access that `fetchRawEmail`
 * from `@mxraven/mail/webhook` downloads. Attempt events are described by
 * {@link AttemptEvent}.
 *
 * The stream keeps events for 24 hours from creation regardless of
 * acknowledgement. Acknowledging stops redelivery; it does not remove the
 * event. A client that is offline longer than the retention window cannot
 * recover the gap. Connections that share one API key share one consumer, so
 * events are distributed between them rather than duplicated to each.
 *
 * The consumer and its subject are managed by the control plane. Enable
 * notifications with the administrative API before connecting; the consumer
 * name defaults to `notify-<listener>`.
 *
 * @packageDocumentation
 */

export { NotificationClient } from "./client.js";
export { DecodeError, NotificationError } from "./errors.js";
export { attemptChannel, notificationKind } from "./event.js";
export type {
  AcceptedNotification,
  AttemptChannel,
  AttemptEvent,
  AttemptNotification,
  NotificationEvent,
  NotificationKind,
} from "./event.js";
export type {
  NotificationDelivery,
  NotificationIterator,
  NakOptions,
  TermOptions,
} from "./iterator.js";
export {
  stopConsuming,
  type ConsumeOptions,
  type EventsOptions,
  type NotificationClientOptions,
  type NotificationContext,
  type NotificationHandler,
  type NotificationHandlerResult,
  type NotificationTlsOptions,
} from "./options.js";
export { statusOutcome } from "../webhook/payload.js";
export type { InboundEmail, StatusOutcome } from "../webhook/payload.js";
