# @mxraven/mail

## 0.2.0

### Minor Changes

- 1983725: Parse full RFC 5322 mailboxes in the address parser, including comments and
  folding whitespace (`CFWS`), quoted strings, quoted local parts, domain
  literals, and obsolete phrase dots. A trailing comment after a bare `addr-spec`
  is used as the display name, and bare line feeds are rejected.
- 1eff167: Add the `@mxraven/mail/feedback` entry point: a `Client` for tenant spam/ham
  training over HTTP Basic auth (`learn`, `learnSpam`, `learnHam`), RFC 8058
  one-click unsubscribes, the `LearningResult` and `Disposition` types, and
  `FeedbackError` with a `retryable` property.
- 1eff167: Add the initial message-composition API: the chainable `Message` builder
  (plain text, HTML, `multipart/alternative`, and `multipart/mixed` attachments),
  the `SMTPError` class, and the submission `Result`/`RecipientResult` types.
- 1eff167: Add the public SMTP submission `Client` with `send` and `sendRaw`, the
  `ClientOptions` and `SendOptions` types, and `SMTPTransactionError` for
  submissions where every recipient was rejected.
- 1eff167: Add the `@mxraven/mail/webhook` entry point: the `Verifier` for HMAC-SHA256
  signature verification with key rotation and timestamp tolerance, `decode` for
  `DELIVER_WEBHOOK` and `NOTIFY_WEBHOOK` payloads, the webhook payload types, and
  `fetchRawEmail` for downloading the referenced raw message.
