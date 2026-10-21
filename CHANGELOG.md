# @mxraven/mail

## 0.6.0

### Minor Changes

- 5a166c9: Bring address parsing to RFC parity with the Go SDK's `raven/mail` parser, fix
  the places where the Go implementation was wrong, and export the parser.

  `Message` and `Client` now parse and normalize every address with the full
  RFC 5322 mailbox grammar:

  - Internationalized domains are converted to their Punycode (A-label) form and
    every domain is lowercased, so `user@例え.jp` becomes `user@xn--r8jz45g.jp`
    and `User@Example.COM` becomes `User@example.com`. A non-ASCII domain no
    longer forces `SMTPUTF8`, because the envelope is ASCII again.
  - RFC 2047 encoded-words in display names are decoded (`=?UTF-8?B?...?=`), so a
    display name round-trips instead of being stored and re-emitted verbatim.
  - Quoted local parts are unquoted in the parsed model and re-quoted only when
    they cannot be written as a dot-string, so `"john.doe"@example.com` is the
    same mailbox as `john.doe@example.com` (RFC 5321 section 4.1.2).
  - Obsolete syntax (`user . name@example.com`, CFWS around dots) is accepted and
    normalized, and folded header values are accepted as RFC 5322 permits.

  New public API: `parseAddress` and `parseAddressList` return a `MailboxAddress`
  (`localPart`, `domain`, `displayName`) that is normalized exactly as the SDK
  normalizes envelope and header addresses, so invalid input can be rejected
  before a `Message` is built and the wire form can be inspected up front.
  `parseAddressList` expands groups and is the entry point for a header such as
  `To` or `Cc`. The formatting helpers stay internal.

  Address validation is now strict where the address may become an envelope
  recipient: the RFC 5321 length limits are enforced, every domain label must be a
  valid DNS label (`user@a_b.com` and `user@-x.com` are rejected), the local part
  may not contain control characters, a domain literal must be a real IPv4, IPv6,
  or general address literal, and encoded display names may not contain control
  characters. Rejections raise the new `AddressError` class with a stable
  `addressErrorKind`, so callers can branch on the failure instead of matching
  message text. A `Message.build()` failure keeps each address error's kind
  inside the `AggregateError`.

  Behavior worth knowing about:

  - An RFC 2047 display name that decodes to CRLF or another control character is
    rejected rather than emitted into a header.
  - Backslashes in quoted display names are escaped, so parse/format/parse
    preserves the name.
  - A domain that normalizes to an empty label (`user@例え.\u200b.jp`) is
    rejected, as is an address literal that is not a real IPv4, IPv6, or general
    address literal.
  - Encoded-words using a character set the platform understands (`windows-1252`,
    `iso-8859-15`) are decoded, and `iso-8859-1` is read as its windows-1252
    superset, which is what senders mean.
  - Display-name dots are preserved (`John Q. Public`, not `John Q Public`).
  - A trailing comment is not promoted to a display name: RFC 5322 makes
    `(Comment)` CFWS, so `user@example.com (Comment)` has no display name, and
    `Name <user@example.com> (Comment)` keeps `Name`.

  `parseEmail` from `@mxraven/mail/mime` now reports the same normalized,
  RFC 2047-decoded addresses, and decodes each display name exactly once. A
  display name is only taken from the RFC 5322 phrase, so a legacy trailing
  comment such as `bob@example.com (Bob)` no longer appears as a name. Raw
  8-bit header bytes are reinterpreted as UTF-8 before the address header is
  parsed, which fixes mojibake in non-encoded international display names. Address
  headers are parsed as a real RFC 5322 list, so groups are expanded
  (`Friends: a@b.example, c@d.example;` yields both members) and an empty group
  such as `undisclosed-recipients:;` yields none. The obsolete leading commas of
  `obs-addr-list` are accepted, while empty list elements and trailing commas are
  rejected rather than silently dropped; a malformed header is still salvaged
  entry by entry.

## 0.5.0

### Minor Changes

- 7855ec9: Expose the mxRaven message reference on notification and status payloads.
  `InboundEmail`, `DeliveryStatus`, `StorageStatus`, and the notify `AttemptEvent`
  now carry `message_ref` (`messageRef` on `AttemptEvent`), the value a submission
  reply reports as `message_ref=`. It is the only field in those payloads that a
  caller already holds before the event arrives, so it joins an event stream back
  to the send that produced it, including every recipient a single send fanned
  out to.

## 0.4.1

### Patch Changes

- Use the published production hosts in examples and TSDoc: SMTP submission at
  `smtp.mxraven.email` on port 587 (STARTTLS; implicit TLS on 465 is not
  published), recipient feedback at the `https://api.mxraven.com` base URL (the
  client appends `/v1/feedback/...`), and the client notification stream at
  `wss://notifications.mxraven.com`.

## 0.4.0

### Minor Changes

- 4f7e873: Add RFC 8689 `REQUIRETLS` support to `Client.send` and `Client.sendRaw` through
  `SendOptions.requireTls`, matching the Go SDK's `Message.RequireTLS` and
  `Envelope.RequireTLS`. The submission server must advertise `REQUIRETLS` or the
  send fails with an `SMTPError` (550 5.7.30). A requested `DELIVERBY` deadline on
  a server that does not advertise it now throws the exported
  `DeliveryByUnsupportedError`, giving callers the same stable programmatic
  identity as the Go SDK's `ErrDeliveryByUnsupported`.

## 0.3.0

### Minor Changes

- 033b1b3: Add `@mxraven/mail/notify`, a client notification consumer for the NATS
  JetStream stream mxRaven publishes to when notifications are enabled for a
  listener. `NotificationClient.connect` authenticates with the listener's
  ordinary API key and resolves its durable consumer. `consume` decodes accepted
  and attempt events, acknowledges successful handlers, redelivers failed ones
  with exponential backoff, and stops on `stopConsuming`. `events` exposes the
  same events as an async iterator for manual `ack`, `nak`, and `term` handling.
  Accepted events reuse the webhook `InboundEmail` payload model; attempt events
  are a camelCase `AttemptEvent` covering the SMTP, S3, and webhook channels.

### Patch Changes

- a286d05: Sync the webhook payload models with the statuses the runtime emits. The
  `statusOutcome` values now include `invalid` for a webhook delivery task that
  was rejected before an attempt, `terminalAction` includes
  `TERMINAL_ACTION_TYPE_UNSPECIFIED`, and `DeliveryStatus` exposes the SMTP
  delivery `reason` classification. These values already arrive on the wire and
  now decode with their published types.

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
