---
"@mxraven/mail": patch
---

Expose envelope extension parameters. `SendOptions` gains `deliveryBy`
(RFC 2852), `dsnRet` and `envid` (RFC 3461), and `extensionParams` for
additional `MAIL FROM` parameters. `Envelope.to` now accepts
`EnvelopeRecipient` objects with per-recipient DSN `notify` and `orcpt`
values alongside plain addresses.
