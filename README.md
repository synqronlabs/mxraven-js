# mxRaven Mail SDK (TypeScript)

[![npm](https://img.shields.io/npm/v/@mxraven/mail?label=NPM&color=007ec6&style=for-the-badge)](https://www.npmjs.com/package/@mxraven/mail)
[![CI](https://img.shields.io/github/actions/workflow/status/synqronlabs/mxraven-js/ci.yml?branch=main&label=CI&style=for-the-badge)](https://github.com/synqronlabs/mxraven-js/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/DOCS-js.mxraven.com-007ec6?style=for-the-badge)](https://js.mxraven.com)
[![license](https://img.shields.io/badge/LICENSE-APACHE%202.0-007ec6?style=for-the-badge)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@mxraven/mail?label=NODE&color=fe7d37&style=for-the-badge)](https://nodejs.org)

A TypeScript SDK for the mxRaven mail-facing runtime surfaces: SMTP submission,
webhook verification and decoding, and recipient feedback.

It is the TypeScript counterpart of the Go SDK at
[`github.com/synqronlabs/mxraven-go/mail`](https://github.com/synqronlabs/mxraven-go/tree/main/mail)
and exposes the same capabilities behind an idiomatic TypeScript API.

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

## Webhooks

Verification and decoding live in a separate entry point that uses the webhook
signing secret, not the submission API key.

```ts
import { Verifier, eventType, fetchRawEmail } from "@mxraven/mail/webhook";

const signingSecret = process.env.MXRAVEN_WEBHOOK_SECRET;
if (signingSecret === undefined || signingSecret === "") {
  throw new Error("MXRAVEN_WEBHOOK_SECRET is required");
}

const verifier = new Verifier({ secret: signingSecret });
const event = await verifier.verifyAndDecode(request);

if (event.type === eventType.inboundEmail) {
  const raw = await fetchRawEmail(event.inboundEmail.raw_email);
}
```

The signing secret is used as literal key bytes; do not base64-decode it. Pass
per-key secrets to `Verifier` with `keys` for rotation. The raw-email
`access_token` is a secret; do not log it.

### Framework support

`Verifier` accepts a WHATWG [`Request`](https://developer.mozilla.org/docs/Web/API/Request).
Runtimes and frameworks that provide one work directly: Cloudflare Workers,
Deno, Bun, Next.js (App Router), Remix, SvelteKit, Astro, Hono (`c.req.raw`),
and `@whatwg-node/server`.

Node frameworks expose their own request objects — `IncomingMessage` in
Express, `FastifyRequest` in Fastify, `ctx` in Koa. Bridge them by constructing
a `Request`, keeping two things in mind:

- The signature covers the **exact raw body**, so preserve the raw bytes; do
  not let a JSON body parser consume them first.
- The signature covers the **public URL**, so reconstruct the scheme and host
  the caller actually used. Behind a proxy that is usually
  `X-Forwarded-Proto`/`X-Forwarded-Host`, not `Host`.

```ts
import express from "express";

const app = express();

app.post(
  "/mxraven/webhook",
  express.raw({ type: "*/*" }), // keeps the exact bytes on req.body
  async (req, res) => {
    const request = new Request(`https://${req.headers.host}${req.originalUrl}`, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: req.body,
    });
    const event = await verifier.verifyAndDecode(request);
    res.sendStatus(204);
  },
);
```

In Fastify, capture the raw buffer in an `addContentTypeParser` hook, then build
the `Request` from `request.method`, `request.url`, and `request.headers`.
`decode` operates on bytes alone, so it can be used without any request object.

The runtime surfaces are published as separate entry points so the root import
stays free of webhook and feedback code:

- `@mxraven/mail/webhook` — HMAC-SHA256 verification, payload decoding, and raw
  message download.
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
