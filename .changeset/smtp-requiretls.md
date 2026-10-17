---
"@mxraven/mail": minor
---

Add RFC 8689 `REQUIRETLS` support to `Client.send` and `Client.sendRaw` through
`SendOptions.requireTls`, matching the Go SDK's `Message.RequireTLS` and
`Envelope.RequireTLS`. The submission server must advertise `REQUIRETLS` or the
send fails with an `SMTPError` (550 5.7.30). A requested `DELIVERBY` deadline on
a server that does not advertise it now throws the exported
`DeliveryByUnsupportedError`, giving callers the same stable programmatic
identity as the Go SDK's `ErrDeliveryByUnsupported`.
