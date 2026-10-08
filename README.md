# mxRaven Mail SDK (TypeScript)

[![npm](https://img.shields.io/npm/v/@mxraven/mail?label=NPM&color=007ec6&style=for-the-badge)](https://www.npmjs.com/package/@mxraven/mail)
[![CI](https://img.shields.io/github/actions/workflow/status/synqronlabs/mxraven-js/ci.yml?branch=main&label=CI&style=for-the-badge)](https://github.com/synqronlabs/mxraven-js/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/DOCS-js.mxraven.com-007ec6?style=for-the-badge)](https://js.mxraven.com)
[![license](https://img.shields.io/badge/LICENSE-APACHE%202.0-007ec6?style=for-the-badge)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@mxraven/mail?label=NODE&color=fe7d37&style=for-the-badge)](https://nodejs.org)

A TypeScript SDK for the mxRaven mail-facing runtime surfaces: SMTP submission,
webhook verification and dispatch, inbound message parsing, and recipient
feedback.

> **Status:** early development. The public API is not yet stable.

## Install

```sh
pnpm add @mxraven/mail
```

## Quick start

```ts
import { Client, Message } from "@mxraven/mail";

const secret = process.env.MXRAVEN_SECRET;
if (secret === undefined || secret === "") {
  throw new Error("MXRAVEN_SECRET is required");
}

const client = new Client({
  host: "smtp.mxraven.com",
  username: "mxr_tx_ab12cd34ef56",
  secret,
});

const result = await client.send(
  new Message()
    .from("Acme <noreply@acme.example>")
    .to("customer@example.com")
    .subject("Your receipt")
    .text("Thanks for your order.")
    .html("<p>Thanks for your order.</p>"),
);

console.log("accepted as", result.messageRef);
await client.close();
```

The submission service requires STARTTLS and SMTP AUTH, so both are always
used. The SDK does not read environment variables itself; the example validates
the variable before constructing the client. Load secrets from a secret manager
in production. Setting both a plain-text and an HTML body produces a
`multipart/alternative` message; `attachFile` and `attachInline` add
`multipart/mixed` attachments.

### Sending raw messages

Use `sendRaw` to stream an already serialized RFC 5322 message with an explicit
envelope. The caller is responsible for RFC 5322 correctness.

```ts
await client.sendRaw(
  { from: "bounce@acme.example", to: ["customer@example.com"] },
  rawMessageBytes,
);
```

### Errors

Rejected commands throw `SMTPError`; when every recipient is rejected,
`SMTPTransactionError` is thrown with the per-recipient `result`.

```ts
import { SMTPError } from "@mxraven/mail";

try {
  await client.send(message);
} catch (error) {
  if (error instanceof SMTPError && error.permanent) {
    // 5xx: do not retry the same message.
  }
}
```

## Templates

Templates are pluggable; the SDK ships only the contract. `Message.render()`
accepts any object with a `render` function that returns HTML, plus optional
text and subject:

```ts
import type { TemplateRenderer } from "@mxraven/mail";

const renderer: TemplateRenderer<{ name: string }> = {
  render: ({ name }) => ({
    html: `<p>Hello ${name}</p>`,
    text: `Hello ${name}`,
  }),
};

await client.send(
  new Message()
    .from("Acme <noreply@acme.example>")
    .to("customer@example.com")
    .subject("Welcome")
    .render(renderer, { name: "Ada" }),
);
```

The renderer runs inside `send`, so asynchronous engines work. Its HTML
replaces an explicit `.html()` body, and its text replaces an explicit
`.text()` body when it returns one; an explicit `.subject()` always wins. When
both text and HTML are present after rendering, the message is sent as
`multipart/alternative`.

## Webhooks

Verification, dispatch, and decoding live in a separate entry point that uses
the webhook signing secret, not the submission API key.

### Handling events

`WebhookHandler` verifies the signature, decodes the JSON payload, and
dispatches it to typed listeners registered with `on`:

```ts
import { WebhookHandler, eventType } from "@mxraven/mail/webhook";

const webhook = new WebhookHandler({ secret: process.env.MXRAVEN_WEBHOOK_SECRET! });

webhook.on(eventType.inboundEmail, async (email) => {
  console.log(email.task_id, email.message.subject);
});

webhook.on(eventType.deliveryStatus, async (status) => {
  console.log(status.status, status.task_id);
});

// Fetch-native runtimes (Workers, Deno, Bun, Next.js, Hono)
export default { fetch: (request: Request) => webhook.handle(request) };
```

Listeners run sequentially in registration order, and the delivery is only
acknowledged after they resolve. `handle` never throws for protocol failures;
the response status is `204` accepted, `400` malformed, `401` bad signature,
`413` body too large, or `500` when a listener throws — which makes mxRaven
retry the delivery.

Frameworks that do not expose a Fetch `Request` pass its fields instead; this
is the only mapping an adapter needs:

```ts
const response = await webhook.handle({
  method: request.method, // the HTTP method
  url: publicUrl, // the absolute, public URL the sender called
  headers: request.headers, // a header map or Headers
  body: rawBody, // the exact raw bytes, never a parsed JSON body
});
```

The response carries only a status; map it to the framework's response API.
Because the signature covers the exact raw body and the public URL, never let a
body parser consume the bytes first, and always reconstruct the URL the sender
used. See [Framework support](#framework-support) for concrete recipes.

An inbound-email event contains the message metadata, the decoded header
summary, every header, and a `raw_email` **reference** with a short-lived
download URL. The body and attachments are not inlined, so download and parse
the message only when you need it:

```ts
import { fetchAndParseRawEmail } from "@mxraven/mail/mime";

webhook.on(eventType.inboundEmail, async (email) => {
  const parsed = await fetchAndParseRawEmail(email.raw_email);
  console.log(parsed.subject, parsed.attachments.length);
});
```

For manual control, use the low-level verifier directly.

### Low-level verification

```ts
import { Verifier, eventType } from "@mxraven/mail/webhook";

const verifier = new Verifier({ secret: process.env.MXRAVEN_WEBHOOK_SECRET! });
const event = await verifier.verifyAndDecode(request);

if (event.type === eventType.inboundEmail) {
  // event.inboundEmail.raw_email references the full message.
}
```

The signing secret is used as literal key bytes; do not base64-decode it. Pass
per-key secrets to `Verifier` with `keys` for rotation. The raw-email
`access_token` is a secret; do not log it.

### Inbound parsing

`@mxraven/mail/mime` decodes raw RFC 5322 bytes into headers, addresses, text
and HTML bodies, and attachments. `fetchAndParseRawEmail` downloads a payload's
`raw_email` reference and parses it in one call (shown above); `parseEmail`
parses bytes you already have:

```ts
import { parseEmail } from "@mxraven/mail/mime";

const email = parseEmail(rawBytes);
console.log(email.subject, email.from, email.attachments);
```

The parser understands `multipart/mixed`, `multipart/alternative`, and
`multipart/related`, decodes `base64` and `quoted-printable` transfer encodings,
decodes RFC 2047 encoded words and reassembles RFC 2231 parameters, and falls
back to UTF-8 and then Latin-1 for unknown charsets. `message/rfc822` parts are
returned as attachments rather than parsed recursively.

### Framework support

Fetch-native runtimes accept the request directly — `webhook.handle(request)`
(or `verifier.verifyAndDecode(request)`): Cloudflare Workers, Deno, Bun,
Next.js (App Router), Remix, SvelteKit, Astro, Hono (`c.req.raw`), and
`@whatwg-node/server`.

Frameworks with their own request objects — `IncomingMessage` in Express,
`FastifyRequest` in Fastify, `ctx` in Koa — map method, public URL, headers, and
raw body onto `handle`. Express:

```ts
import express from "express";

const app = express();
app.set("trust proxy", true); // use X-Forwarded-Proto/Host behind a proxy

app.post(
  "/mxraven/webhook",
  express.raw({ type: "*/*" }), // keeps the exact bytes on req.body
  async (req, res) => {
    // express.raw() must be mounted before any express.json() parser.
    const response = await webhook.handle({
      method: req.method,
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      headers: req.headers,
      body: req.body,
    });
    res.sendStatus(response.status);
  },
);
```

In Fastify, capture the raw buffer with an `addContentTypeParser` hook, then
pass `request.method`, the public URL, `request.headers`, and the buffer to
`handle`. With the low-level `Verifier`, construct a `Request` from the same
fields first; `decode` operates on bytes alone, so it can be used without any
request object.

The runtime surfaces are published as separate entry points so the root import
stays free of webhook and feedback code:

- `@mxraven/mail/webhook` — HMAC-SHA256 verification, typed event dispatch,
  payload decoding, and raw message download.
- `@mxraven/mail/mime` — inbound message parsing into headers, addresses,
  bodies, and attachments.
- `@mxraven/mail/feedback` — tenant spam/ham training and RFC 8058 one-click
  unsubscribes.

### Feedback

Teach the spam filter with the exact raw message bytes mxRaven processed, or
perform a one-click unsubscribe. Learning uses the same submission API key as
SMTP submission, over HTTP Basic auth.

```ts
import { Client } from "@mxraven/mail/feedback";

const secret = process.env.MXRAVEN_SECRET;
if (secret === undefined || secret === "") {
  throw new Error("MXRAVEN_SECRET is required");
}

const feedback = new Client({
  baseUrl: "https://feedback.mxraven.com",
  username: "mxr_tx_ab12cd34ef56",
  secret,
});

await feedback.learnSpam(rawMessageBytes);
```

## Examples

Reference examples live in
[`examples/`](https://github.com/synqronlabs/mxraven-js/tree/main/examples).
They are not part of the published package, are excluded from the typecheck, and
are not run by the build. Each file starts with the credentials or paths to
replace, then shows one workflow:

| Example                    | Shows                                                          |
| -------------------------- | -------------------------------------------------------------- |
| `send-with-attachments.ts` | SMTP submission with a regular and an inline `cid:` attachment |
| `webhook-node.ts`          | A dependency-free Node HTTP adapter                            |
| `webhook-express.ts`       | Express 5 with `express.raw()` and `trust proxy`               |
| `webhook-fastify.ts`       | Fastify with a buffer content-type parser                      |
| `webhook-hono.ts`          | Hono on Workers/Deno/Bun, passing `Request` straight through   |
| `parse-inbound.ts`         | Decoding an `.eml` file into headers, bodies, and attachments  |
| `feedback.ts`              | Spam/ham training and one-click unsubscribe                    |

## Development

Requires Node.js 20.19 or later and pnpm.

```sh
pnpm install     # install dependencies
pnpm run build   # dual ESM + CJS build with declarations (tsdown)
pnpm run test    # vitest
pnpm run lint    # oxlint (includes TSDoc validation)
pnpm run format  # oxfmt
pnpm run docs    # typedoc (Markdown) into docs/
```

`pnpm run check` runs formatting, lint, typecheck, test, and build in sequence.

## Toolchain

| Concern                | Tool                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Language / typecheck   | TypeScript (`tsc --noEmit`), NodeNext, strict                                                                         |
| Build (dual ESM + CJS) | [tsdown](https://tsdown.dev) (Rolldown) with declarations and source maps                                             |
| Testing                | [Vitest](https://vitest.dev)                                                                                          |
| Lint / format          | [oxlint](https://oxc.rs) + [oxfmt](https://oxc.rs)                                                                    |
| TSDoc validation       | `eslint-plugin-tsdoc` loaded as an oxlint JS plugin                                                                   |
| API docs               | [TypeDoc](https://typedoc.org) + `typedoc-plugin-markdown`                                                            |
| Versioning / release   | [Changesets](https://github.com/changesets/changesets), published from GitHub Actions with `npm publish --provenance` |

## Releases

Releases are managed with Changesets. Add a changeset with `pnpm run changeset`;
merging the generated release pull request bumps versions and publishes to npm
with provenance.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
