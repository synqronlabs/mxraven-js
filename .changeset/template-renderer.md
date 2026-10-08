---
"@mxraven/mail": patch
---

Add a template renderer seam: `Message.render(renderer, input)` accepts any
`TemplateRenderer` and runs it inside `Client.send`. The exported
`TemplateRenderer` and `RenderedTemplate` types require only HTML (text and
subject are optional), so template engines can live in separate plugin packages.
Rendered HTML replaces an explicit `.html()` body, rendered text replaces an
explicit `.text()` body when present, and an explicit `.subject()` wins. Text
and HTML together are sent as `multipart/alternative`.
