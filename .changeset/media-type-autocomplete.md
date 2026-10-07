---
"@mxraven/mail": minor
---

Add the exported `MediaType` type and use it for `Attachment.contentType`.
Common media types now autocomplete in editors while any other `type/subtype`
string is still accepted, because the MIME registry is open.
