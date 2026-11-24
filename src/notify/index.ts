/**
 * Client notification events over NATS JetStream.
 *
 * The notification stream is mxRaven's only push channel for mail events. When
 * notifications are enabled for a listener, mxRaven publishes every accepted
 * message, every delivery attempt, and sampled routing-script faults to that
 * listener's durable JetStream consumer. This entry point consumes those events
 * with the listener's ordinary API key:
 *
 * ```ts
 * import { NotificationClient } from "@mxraven/mail/notify";
 *
 * const client = await NotificationClient.connect({
 *   url: "wss://notifications.mxraven.com",
 *   username: "mxr_tx_ab12cd34ef56",
 *   secret: process.env.MXRAVEN_SECRET!,
 *   listener: listenerId,
 * });
 *
 * await client.consume((event) => {
 *   if (event.kind === "accepted") {
 *     console.log(event.accepted.taskId, event.accepted.routingDecision.terminalAction);
 *   } else if (event.kind === "attempt") {
 *     console.log(event.attempt.taskId, event.attempt.status);
 *   } else {
 *     console.warn("script fault", event.fault.fault.reason, event.fault.suppressedFaults);
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
 * An accepted event carries the parsed message, the SMTP envelope, the
 * routing-script decision, and — for an MTA listener — raw-message access that
 * {@link fetchRawEmail} downloads. Attempt events are described by
 * {@link AttemptEvent}: one event per egress side effect a routing script
 * triggered. A fault event is described by {@link FaultEvent}: an MTA script
 * fault defers the transaction, so the fault arrives here instead of on an
 * accepted event.
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

export type {
  AcceptedEnvelope,
  AcceptedMessage,
  HeaderField,
  MessageSummary,
  RawEmail,
  Verdicts,
} from "./accepted.js";
export { NotificationClient } from "./client.js";
export { DecodeError, NotificationError } from "./errors.js";
export { attemptChannel, notificationKind, statusOutcome } from "./event.js";
export type {
  AcceptedNotification,
  AttemptChannel,
  AttemptEvent,
  AttemptNotification,
  FaultEvent,
  FaultNotification,
  NotificationEvent,
  NotificationKind,
  StatusOutcome,
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
export { fetchRawEmail } from "./raw.js";
export type { FetchLike, FetchRawEmailOptions } from "./raw.js";
export { routingIntentKind, terminalAction } from "./routing.js";
export type {
  RoutingDecision,
  RoutingFault,
  RoutingHttpCall,
  RoutingIntent,
  RoutingIntentKind,
  RoutingSkip,
  TerminalAction,
} from "./routing.js";
