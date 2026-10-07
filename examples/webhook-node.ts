// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";

import { WebhookHandler, eventType } from "@mxraven/mail/webhook";

// Replace with your webhook endpoint's signing secret.
const MXRAVEN_WEBHOOK_SECRET = "whsec_your-signing-secret";
const PORT = 3000;
const MAX_BODY_BYTES = 1 << 20;

const webhook = new WebhookHandler({ secret: MXRAVEN_WEBHOOK_SECRET });

webhook.on(eventType.inboundEmail, (email) => {
  console.log(`inbound ${email.task_id}: ${email.message.subject ?? "(no subject)"}`);
});

webhook.on(eventType.deliveryStatus, (status) => {
  console.log(`delivery ${status.task_id}: ${status.status}`);
});

/** Collects the exact raw body, bounded, from the Node stream. */
async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const url = request.url ?? "/";
  if (request.method !== "POST" || url.split("?")[0] !== "/mxraven/webhook") {
    response.writeHead(404).end();
    return;
  }

  const body = await readBody(request);
  if (body === undefined) {
    response.writeHead(413).end();
    return;
  }

  const result = await webhook.handle({
    method: request.method,
    url: `http://${request.headers.host ?? "localhost"}${url}`,
    headers: request.headers,
    body,
  });
  response.writeHead(result.status).end();
});

server.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}/mxraven/webhook`);
});
