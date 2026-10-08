# @mxraven/mail

## 0.2.4

### Patch Changes

- 9c74627: Fix BDAT transactions so the final server reply populates the public result.
  Automatic BDAT sends (composed messages larger than 1 MiB) and chunked BDAT
  sends previously returned `code: 0`, an empty `message`, and an empty
  `messageRef` because the final reply was validated but never recorded.
- 9c74627: Expose envelope extension parameters. `SendOptions` gains `deliveryBy`
  (RFC 2852), `dsnRet` and `envid` (RFC 3461), and `extensionParams` for
  additional `MAIL FROM` parameters. `Envelope.to` now accepts
  `EnvelopeRecipient` objects with per-recipient DSN `notify` and `orcpt`
  values alongside plain addresses.

## 0.2.3

### Patch Changes

- 4f00a07: Fix submission of messages with non-ASCII or over-long text lines. Text parts
  with a line longer than the RFC 5322 limit (998 characters) are now encoded
  with quoted-printable, so the serialized message never exceeds the SMTP line
  limit enforced by submission servers. Non-ASCII bodies with shorter lines keep
  `Content-Transfer-Encoding: 8bit` and now declare `BODY=8BITMIME` on
  `MAIL FROM`, which servers such as raven require before accepting 8-bit
  `DATA`. Previously both cases were rejected with
  `451 4.3.0 unable to spool message body`.

## 0.2.2

### Patch Changes

- 9b1f335: Add a template renderer seam: `Message.render(renderer, input)` accepts any
  `TemplateRenderer` and runs it inside `Client.send`. The exported
  `TemplateRenderer` and `RenderedTemplate` types require only HTML (text and
  subject are optional), so template engines can live in separate plugin packages.
  Rendered HTML replaces an explicit `.html()` body, rendered text replaces an
  explicit `.text()` body when present, and an explicit `.subject()` wins. Text
  and HTML together are sent as `multipart/alternative`.

## 0.2.1

### Patch Changes

- 928adc6: Add `@mxraven/mail/mime` for inbound message parsing: `parseEmail` decodes raw
  RFC 5322 bytes into headers, addresses, text and HTML bodies, and attachments,
  and `fetchAndParseRawEmail` downloads a webhook `raw_email` reference and parses
  it in one call. `multipart/mixed`, `multipart/alternative`, and
  `multipart/related` are traversed, `base64` and `quoted-printable` transfer
  encodings, RFC 2047 encoded words, and RFC 2231 parameters are decoded, with
  UTF-8 and Latin-1 fallbacks for unknown charsets. `message/rfc822` parts are
  surfaced as attachments.
- 928adc6: Add the exported `MediaType` type and use it for `Attachment.contentType`.
  Common media types now autocomplete in editors while any other `type/subtype`
  string is still accepted, because the MIME registry is open.
- 928adc6: Add `WebhookHandler` to `@mxraven/mail/webhook`. It verifies, decodes, and
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
