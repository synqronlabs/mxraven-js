---
"@mxraven/mail": patch
---

Add `@mxraven/mail/mime` for inbound message parsing: `parseEmail` decodes raw
RFC 5322 bytes into headers, addresses, text and HTML bodies, and attachments,
and `fetchAndParseRawEmail` downloads a webhook `raw_email` reference and parses
it in one call. `multipart/mixed`, `multipart/alternative`, and
`multipart/related` are traversed, `base64` and `quoted-printable` transfer
encodings, RFC 2047 encoded words, and RFC 2231 parameters are decoded, with
UTF-8 and Latin-1 fallbacks for unknown charsets. `message/rfc822` parts are
surfaced as attachments.
