# mxRaven Mail SDK (TypeScript)

[![npm](https://img.shields.io/npm/v/@mxraven/mail?label=NPM&color=007ec6&style=for-the-badge)](https://www.npmjs.com/package/@mxraven/mail)
[![CI](https://img.shields.io/github/actions/workflow/status/synqronlabs/mxraven-js/ci.yml?branch=main&label=CI&style=for-the-badge)](https://github.com/synqronlabs/mxraven-js/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/DOCS-js.mxraven.com-007ec6?style=for-the-badge)](https://js.mxraven.com)
[![license](https://img.shields.io/badge/LICENSE-APACHE%202.0-007ec6?style=for-the-badge)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@mxraven/mail?label=NODE&color=fe7d37&style=for-the-badge)](https://nodejs.org)

A TypeScript SDK for the mxRaven mail-facing runtime surfaces: SMTP submission,
signed endpoint-call verification, inbound message parsing, client
notifications, and recipient feedback.

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
  host: "smtp.mxraven.email",
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

### Envelope parameters

`send` and `sendRaw` accept RFC 2852 and RFC 3461 envelope parameters through
`SendOptions`:

```ts
await client.send(message, {
  deliveryBy: { seconds: 3600, mode: "R" }, // DELIVERBY; requires server support
  requireTls: true, // REQUIRETLS; requires server support
  dsnRet: "FULL", // RET; requires DSN
  envid: "order-42", // ENVID; requires DSN
  extensionParams: new Map([["X-CUSTOM", "value"]]), // extra MAIL FROM parameters
});
```

`requireTls` sets the RFC 8689 `REQUIRETLS` parameter, requiring TLS on
every delivery hop. The submission server must advertise `REQUIRETLS`;
otherwise the send throws an `SMTPError` with code `550` and enhanced status
`5.7.30`. Submission already uses STARTTLS, so the local TLS precondition is
always met.

Per-recipient DSN parameters go on the envelope, which `sendRaw` accepts as
objects alongside plain addresses:

```ts
await client.sendRaw(
  {
    from: "bounce@acme.example",
    to: [
      {
        address: "customer@example.com",
        notify: ["FAILURE", "DELAY"],
        orcpt: "original@acme.example", // sent as rfc822;original@acme.example
      },
    ],
  },
  rawMessageBytes,
);
```

`deliveryBy` fails with `DeliveryByUnsupportedError` when the server does not
advertise `DELIVERBY`; mode `R` must meet the server's advertised minimum
interval.

### Errors

Rejected commands throw `SMTPError`; when every recipient is rejected,
`SMTPTransactionError` is thrown with the per-recipient `result`. A requested
`DELIVERBY` deadline on a server that does not advertise the extension throws
`DeliveryByUnsupportedError` before the transaction starts.

```ts
import { AddressError, SMTPError, addressErrorKind } from "@mxraven/mail";

try {
  await client.send(message);
} catch (error) {
  if (error instanceof SMTPError && error.permanent) {
    // 5xx: do not retry the same message.
  }
  if (error instanceof AggregateError) {
    for (const problem of error.errors) {
      if (problem instanceof AddressError && problem.kind === addressErrorKind.invalidDomain) {
        // The address's domain is not a valid DNS name or IDN.
      }
    }
  }
}
```

Addresses are parsed with the RFC 5322 mailbox grammar and normalized before
use: internationalized domains become Punycode, domains are lowercased, quoted
local parts are unquoted, and RFC 2047 display names are decoded. Validation
follows the RFC 5321 length limits, so an address that cannot be put on the
wire fails at build time with an `AddressError` whose `kind` is one of
`addressErrorKind`.

### Addresses

`parseAddress` and `parseAddressList` expose that parser, so you can validate or
normalize an address without building a message. They return a
`MailboxAddress` (`localPart`, `domain`, `displayName`), the same normalized
value the SDK puts on the wire; `parseAddressList` expands groups and is what to
use for a header such as `To` or `Cc`.

```ts
import { parseAddress, parseAddressList } from "@mxraven/mail";

const sender = parseAddress("Acme <Noreply@例え.jp>");
// { localPart: "Noreply", domain: "xn--r8jz45g.jp", displayName: "Acme" }

parseAddressList('Friends: "Doe, John" <j@example.com>, a@example.com;');
// two mailboxes; the group name and empty group "undisclosed-recipients:;" are
// not addresses
```

Rejections throw `AddressError` with a stable `kind`, so no message matching is
needed. A comment is not a display name, so `user@example.com (Bob)` parses
without one, and an address that cannot be sent — a bad domain label, an
invalid IP literal, an over-long local part, or a decoded control character — is
rejected rather than silently normalized.

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

### React templates

The companion [`@mxraven/react`](https://www.npmjs.com/package/@mxraven/react)
package renders React templates on the server
wherever you call `client.send()`, never in the browser. Install it alongside
React:

```sh
pnpm add @mxraven/react
```

```tsx
import { Client, Message } from "@mxraven/mail";
import { react } from "@mxraven/react";

function Welcome({ firstName }: { firstName: string }) {
  return <h1>Welcome, {firstName}!</h1>;
}

const client = new Client({
  host: "smtp.mxraven.email",
  username: "mxr_tx_ab12cd34ef56",
  secret: process.env.MXRAVEN_SECRET!,
});

await client.send(
  new Message()
    .from("Acme <noreply@acme.example>")
    .to("customer@example.com")
    .subject("Welcome")
    .render(react(), <Welcome firstName="Ada" />),
);
```

## Signed endpoint calls

Routing scripts call tenant-registered endpoints with `mx.http`. mxRaven signs
each call with the endpoint's signing secret — not the submission API key —
using the same `X-MxRaven-*` scheme it used for webhook deliveries. The script
decides the request body, so `@mxraven/mail/webhook` stops at the signature:
parse the body your endpoint defines.

### Verifying a call

```ts
import { Verifier, WebhookError, webhookHeaders } from "@mxraven/mail/webhook";

const secret = process.env.MXRAVEN_ENDPOINT_SECRET;
if (secret === undefined || secret === "") {
  throw new Error("MXRAVEN_ENDPOINT_SECRET is required");
}

const verifier = new Verifier({ secret });

export default {
  async fetch(request: Request) {
    try {
      await verifier.verify(request);
    } catch (error) {
      // 400 malformed, 401 bad signature, 413 body too large.
      const status = error instanceof WebhookError ? error.status : 500;
      return new Response(null, { status });
    }

    console.log(
      "call from listener",
      request.headers.get(webhookHeaders.listener),
      "revision",
      request.headers.get(webhookHeaders.revision),
    );
    const payload = await request.json();
    return Response.json({ verdict: "allow" });
  },
};
```

`Verifier.verify` reads the body from a request clone, so the original request
remains readable. Frameworks that do not expose a Fetch `Request` pass its
fields instead; this is the only mapping an adapter needs:

```ts
await verifier.verify({
  method: request.method, // the HTTP method
  url: publicUrl, // the absolute, public URL the sender called
  headers: request.headers, // a header map or Headers
  body: rawBody, // the exact raw bytes, never a parsed JSON body
});
```

Because the signature covers the exact raw body and the public URL, never let a
body parser consume the bytes first, and always reconstruct the URL the sender
used. See [Framework support](#framework-support) for concrete recipes.

The signing secret is used as literal key bytes; do not base64-decode it. Pass
per-key secrets to `Verifier` with `keys` for rotation. The
`X-MxRaven-Listener` and `X-MxRaven-Revision` headers identify the script call
but are not part of the signed canonical request, so do not use them for
authorization.

An endpoint configured with a stored credential is called with that credential
header instead of mxRaven's signature. Those calls carry no `X-MxRaven-*`
headers, so `Verifier` does not apply; authenticate the credential the endpoint
expects.

Webhook deliveries (`DELIVER_WEBHOOK`, `NOTIFY_WEBHOOK`, and delivery-status
callbacks) no longer exist. Accepted messages, delivery attempts, and sampled
routing-script faults arrive on the
[notification stream](#client-notifications); a tenant that wants a custom push
calls its own endpoint from the routing script.

### Framework support

Fetch-native runtimes pass the request directly to `Verifier.verify`: Cloudflare
Workers, Deno, Bun, Next.js (App Router), Remix, SvelteKit, Astro, Hono
(`c.req.raw`), and `@whatwg-node/server`.

Frameworks with their own request objects — `IncomingMessage` in Express,
`FastifyRequest` in Fastify, `ctx` in Koa — map method, public URL, headers, and
raw body onto the verifier. Express:

```ts
import { WebhookError, Verifier } from "@mxraven/mail/webhook";
import express from "express";

const verifier = new Verifier({ secret: process.env.MXRAVEN_ENDPOINT_SECRET! });

const app = express();
app.set("trust proxy", true); // use X-Forwarded-Proto/Host behind a proxy

app.post(
  "/mxraven/risk-check",
  express.raw({ type: "*/*" }), // keeps the exact bytes on req.body
  async (req, res) => {
    // express.raw() must be mounted before any express.json() parser.
    try {
      await verifier.verify({
        method: req.method,
        url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        headers: req.headers,
        body: req.body,
      });
    } catch (error) {
      const status = error instanceof WebhookError ? error.status : 500;
      res.sendStatus(status);
      return;
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    res.status(200).json({ verdict: "allow", from: payload.from });
  },
);
```

In Fastify, capture the raw buffer with an `addContentTypeParser` hook, then
pass `request.method`, the public URL, `request.headers`, and the buffer to
`verify`.

The runtime surfaces are published as separate entry points so the root import
stays free of endpoint, notification, and feedback code:

- `@mxraven/mail/webhook` — HMAC-SHA256 verification of signed `mx.http` calls.
- `@mxraven/mail/mime` — inbound message parsing into headers, addresses,
  bodies, and attachments.
- `@mxraven/mail/notify` — client notification events over NATS JetStream and
  raw-message download.
- `@mxraven/mail/feedback` — tenant spam/ham training and RFC 8058 one-click
  unsubscribes.

## Inbound parsing

`@mxraven/mail/mime` decodes raw RFC 5322 bytes into headers, addresses, text
and HTML bodies, and attachments. `fetchAndParseRawEmail` downloads an accepted
event's `rawEmail` reference and parses it in one call; `parseEmail` parses
bytes you already have:

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

## Client notifications

The notification stream is mxRaven's only push channel for mail events. Enable
notifications for a listener with the administrative API, then consume that
listener's accepted-message, delivery-attempt, and routing-script fault events
over NATS. The client authenticates with the same API key used for SMTP
submission and manages the WebSocket transport, acknowledgement, and
redelivery:

```ts
import { NotificationClient } from "@mxraven/mail/notify";

const secret = process.env.MXRAVEN_SECRET;
if (secret === undefined || secret === "") {
  throw new Error("MXRAVEN_SECRET is required");
}

const client = await NotificationClient.connect({
  url: "wss://notifications.mxraven.com",
  username: "mxr_tx_ab12cd34ef56",
  secret,
  listener: listenerId,
});

await client.consume((event) => {
  if (event.kind === "accepted") {
    console.log("accepted", event.accepted.taskId, event.accepted.routingDecision.terminalAction);
  } else if (event.kind === "attempt") {
    console.log("attempt", event.attempt.taskId, event.attempt.channel, event.attempt.status);
  } else {
    console.warn("script fault", event.fault.fault.reason, event.fault.suppressedFaults);
  }
});
```

A handler that returns normally acknowledges the event. A handler that throws
leaves it unacknowledged, and the server redelivers it with exponential backoff.
Return `stopConsuming` to acknowledge the current event and stop. Cancellation
with an `AbortSignal` and `client.close()` are normal stops and resolve the
promise.

An accepted event carries the parsed message, the SMTP envelope, the routing
decision, and — for an MTA listener — a `rawEmail` reference. Download and parse
the message only when you need it:

```ts
import { fetchRawEmail } from "@mxraven/mail/notify";
import { parseEmail } from "@mxraven/mail/mime";

if (event.kind === "accepted" && event.accepted.rawEmail.accessToken !== "") {
  const email = parseEmail(await fetchRawEmail(event.accepted.rawEmail));
  console.log(email.subject, email.attachments.length);
}
```

A submission listener's `rawEmail` is empty because raw-message access is
granted to MTA listeners only. `rawEmail.accessToken` is a secret; do not log it.

`routingDecision` records what the listener's routing script did:
`terminalAction`, `usedListenerDefault`, the published `scriptRevisionId` and
`scriptRevision`, the executed non-terminal `intents`, the `skipped` intents,
the script's `log` lines, any `fault`, and every `mx.http` call in `httpCalls`.
A repeated identical call within one MTA transaction carries
`httpCalls[].cached`. That is enough to debug a listener from the stream alone.

A routing-script fault on an MTA listener defers the transaction with a
`451 4.3.0`, so it produces a `fault` event instead of an accepted event. The
`FaultEvent` carries the deferred `messageRef`, envelope `mailFrom`, faulted
`recipient`, the `smtpResponse` the sender received, the script revision, the
`fault` reason and message, the script's `log` lines, and its `httpCalls`.
Fault events are sampled: each `smtp-mta` replica publishes at most one per
script revision per minute, and `suppressedFaults` counts the same revision's
faults it did not report since its previous event.

An attempt event is an `AttemptEvent` whose `channel` is `smtp` or `s3`.
`correlationId` joins a side-effect attempt back to the accepted event's
`taskId`, and `messageRef` groups the attempts of a fan-out.

`messageRef` also joins an event to the send that produced it: `send()` reports
the same value as `result.messageRef`. It is the only identifier in an event
that the caller already holds, and it groups the attempts of a fan-out that
otherwise have distinct task IDs.

For manual acknowledgement, iterate events with `client.events()`. Each
delivery exposes `ack()`, `nak({ delay })`, and `term()`:

```ts
for await (const { event, ack, nak } of client.events({ signal })) {
  try {
    await process(event);
    ack();
  } catch {
    nak({ delay: 5_000 });
  }
}
```

The stream retains events for 24 hours regardless of acknowledgement, so a
client that is offline longer than that cannot recover the gap. Connections
that share one API key share one durable consumer: events are distributed
between them, not duplicated to each. Use the `tls` option to trust a private
certificate authority or present a client certificate.

## Feedback

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
  baseUrl: "https://api.mxraven.com",
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
| `send-with-react.tsx`      | Server-side React Email rendering through `@mxraven/react`     |
| `endpoint-express.ts`      | Express 5 with `express.raw()` and `trust proxy`               |
| `endpoint-hono.ts`         | Hono on Workers/Deno/Bun, passing `Request` straight through   |
| `parse-inbound.ts`         | Decoding an `.eml` file into headers, bodies, and attachments  |
| `notifications.ts`         | Consuming client notification events from a NATS JetStream     |
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
