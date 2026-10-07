---
"@mxraven/mail": patch
---

Add `WebhookHandler` to `@mxraven/mail/webhook`. It verifies, decodes, and
dispatches mxRaven webhook events to typed listeners with
`on(eventType.inboundEmail, ...)`. `handle` accepts either a Fetch API
`Request` or framework request primitives (`method`, `url`, `headers`, `body`),
so Express/Fastify/other adapters can call it without rebuilding a request.
Protocol failures are reported as typed statuses
(`400`/`401`/`413`/`500`) instead of thrown errors, listeners run in
registration order, and the delivery is only acknowledged after every listener
resolves so failures trigger an mxRaven retry. New error classes
`WebhookError`, `WebhookRequestError`, and `PayloadTooLargeError` are exported
alongside the existing `InvalidSignatureError`.
