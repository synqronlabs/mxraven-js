---
"@mxraven/mail": patch
---

Fix BDAT transactions so the final server reply populates the public result.
Automatic BDAT sends (composed messages larger than 1 MiB) and chunked BDAT
sends previously returned `code: 0`, an empty `message`, and an empty
`messageRef` because the final reply was validated but never recorded.
