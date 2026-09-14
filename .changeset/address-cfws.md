---
"@mxraven/mail": minor
---

Parse full RFC 5322 mailboxes in the address parser, including comments and
folding whitespace (`CFWS`), quoted strings, quoted local parts, domain
literals, and obsolete phrase dots. A trailing comment after a bare `addr-spec`
is used as the display name, and bare line feeds are rejected.
