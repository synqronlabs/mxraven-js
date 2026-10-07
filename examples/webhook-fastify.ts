// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { WebhookHandler, eventType } from "@mxraven/mail/webhook";
import Fastify from "fastify";

// Replace with your webhook endpoint's signing secret.
const MXRAVEN_WEBHOOK_SECRET = "whsec_your-signing-secret";
const PORT = 3000;

const webhook = new WebhookHandler({ secret: MXRAVEN_WEBHOOK_SECRET });

webhook.on(eventType.inboundEmail, (email) => {
  console.log(`inbound ${email.task_id}: ${email.message.subject ?? "(no subject)"}`);
});

webhook.on(eventType.deliveryStatus, (status) => {
  console.log(`delivery ${status.task_id}: ${status.status}`);
});

const app = Fastify({ logger: true });

// Keep the exact raw bytes instead of letting Fastify parse JSON.
app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
  done(null, body);
});

app.post("/mxraven/webhook", async (request, reply) => {
  if (!Buffer.isBuffer(request.body)) {
    return reply.code(400).send();
  }

  const response = await webhook.handle({
    method: request.method,
    url: `${request.protocol}://${request.host}${request.url}`,
    headers: request.headers,
    body: request.body,
  });
  return reply.code(response.status).send();
});

await app.listen({ port: PORT, host: "0.0.0.0" });
