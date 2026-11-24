---
"@mxraven/mail": major
---

Track the routing-script and notification-stream model. Webhook deliveries were
removed from mxRaven, and every listener's routing is now a Lua script whose
decision is reported on the notification stream.

**Breaking changes:**

- `@mxraven/mail/notify` now decodes accepted events into a camelCase
  `AcceptedMessage` with `routingDecision`, `intents`, `skipped`, `log`,
  `fault`, and `httpCalls`, replacing the verbatim webhook payload model.
  `rawEmail` (formerly `raw_email`) moved here together with `fetchRawEmail`.
  Event kinds come from the subject, with a `channel`/`routing_decision` probe
  when it is unavailable; the removed `event_type` field is not required, and
  events still carrying it during the retention window decode normally.
- Attempt events no longer carry the `webhook` channel or its fields, the
  `invalid` status outcome is gone, and the legacy `eventType` marker is no
  longer exposed (use `channel`). `statusCode` now describes `s3` attempts only.
- `@mxraven/mail/webhook` now verifies signed `mx.http` endpoint calls only:
  `WebhookHandler`, `decode`, the webhook payload types, and typed dispatch were
  removed. `Verifier.verify` also accepts framework request primitives, and the
  listener and revision header names are exported.
- `fetchRawEmail` moved from `@mxraven/mail/webhook` to `@mxraven/mail/notify`.
  `fetchAndParseRawEmail` in `@mxraven/mail/mime` takes the camelCase `rawEmail`
  object.

**Additions:**

- Added the sampled MTA routing-script `fault` event (`kind: "fault"`,
  `FaultEvent`) and `notificationKind.fault`. An MTA script fault now defers the
  transaction with `451 4.3.0` and arrives as a fault event instead of an
  accepted event.
- Added `RoutingHttpCall.cached`, set when an identical `mx.http` call in the
  same MTA transaction was answered from the first call's response.
- Payload decoding is stricter: required identity, routing-decision, and fault
  fields must be present, identity strings must be non-empty, and `attempt` must
  be positive.
- `fetchRawEmail` now requires a `200 OK` response rather than accepting any
  successful status.
- `@mxraven/mail/webhook` documents that endpoints configured with a stored
  credential receive unsigned calls with no `X-MxRaven-*` headers, so `Verifier`
  does not apply to them.
