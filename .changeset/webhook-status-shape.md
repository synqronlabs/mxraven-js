---
"@mxraven/mail": patch
---

Sync the webhook payload models with the statuses the runtime emits. The
`statusOutcome` values now include `invalid` for a webhook delivery task that
was rejected before an attempt, `terminalAction` includes
`TERMINAL_ACTION_TYPE_UNSPECIFIED`, and `DeliveryStatus` exposes the SMTP
delivery `reason` classification. These values already arrive on the wire and
now decode with their published types.
