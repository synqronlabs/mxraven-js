---
"@mxraven/mail": minor
---

Add `@mxraven/mail/notify`, a client notification consumer for the NATS
JetStream stream mxRaven publishes to when notifications are enabled for a
listener. `NotificationClient.connect` authenticates with the listener's
ordinary API key and resolves its durable consumer. `consume` decodes accepted
and attempt events, acknowledges successful handlers, redelivers failed ones
with exponential backoff, and stops on `stopConsuming`. `events` exposes the
same events as an async iterator for manual `ack`, `nak`, and `term` handling.
Accepted events reuse the webhook `InboundEmail` payload model; attempt events
are a camelCase `AttemptEvent` covering the SMTP, S3, and webhook channels.
