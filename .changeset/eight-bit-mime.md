---
"@mxraven/mail": patch
---

Fix submission of messages with non-ASCII or over-long text lines. Text parts
with a line longer than the RFC 5322 limit (998 characters) are now encoded
with quoted-printable, so the serialized message never exceeds the SMTP line
limit enforced by submission servers. Non-ASCII bodies with shorter lines keep
`Content-Transfer-Encoding: 8bit` and now declare `BODY=8BITMIME` on
`MAIL FROM`, which servers such as raven require before accepting 8-bit
`DATA`. Previously both cases were rejected with
`451 4.3.0 unable to spool message body`.
