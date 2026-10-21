---
"@mxraven/mail": minor
---

Bring address parsing to RFC parity with the Go SDK's `raven/mail` parser, fix
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
characters. Rejections raise the new {@link AddressError} class
with a stable {@link addressErrorKind}, so callers can branch on the failure
instead of matching message text. A `Message.build()` failure keeps each
address error's kind inside the `AggregateError`.

Deliberate differences from the Go parser, all where the Go behavior is unsafe
or lossy:

- An RFC 2047 display name that decodes to a CRLF or another control character
  is rejected instead of being emitted into a header.
- Backslashes in quoted display names are escaped, so parse/format/parse
  preserves the name.
- Domains that normalize to an empty label (`user@例え.\u200b.jp`) are rejected
  instead of being emitted as `xn--r8jz45g..jp`, and `[notip]` is rejected
  rather than sent as a recipient domain.
- Encoded-words using a character set the platform understands (`windows-1252`,
  `iso-8859-15`) are decoded instead of failing, and `iso-8859-1` is read as its
  windows-1252 superset, which is what senders mean.
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
