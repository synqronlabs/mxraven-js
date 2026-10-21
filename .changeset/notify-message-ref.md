---
"@mxraven/mail": minor
---

Expose the mxRaven message reference on notification and status payloads.
`InboundEmail`, `DeliveryStatus`, `StorageStatus`, and the notify `AttemptEvent`
now carry `message_ref` (`messageRef` on `AttemptEvent`), the value a submission
reply reports as `message_ref=`. It is the only field in those payloads that a
caller already holds before the event arrives, so it joins an event stream back
to the send that produced it, including every recipient a single send fanned
out to.
