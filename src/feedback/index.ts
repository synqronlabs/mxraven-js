/**
 * Recipient feedback and RFC 8058 one-click unsubscribe support.
 *
 * Tenants teach the mxRaven spam filter by reporting messages that were
 * misclassified. The service matches a submitted message to the exact bytes it
 * processed, so the raw RFC 822 message must be provided unchanged. This entry
 * point also exposes the RFC 8058 one-click unsubscribe endpoint that recipient
 * mail clients call.
 *
 * @packageDocumentation
 */

export { Client, disposition } from "./client.js";
export type {
  ClientOptions,
  Disposition,
  FetchLike,
  LearningResult,
  RequestOptions,
} from "./client.js";
export { FeedbackError } from "./errors.js";
