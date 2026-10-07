// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { WebhookHandler, eventType } from "@mxraven/mail/webhook";
import { Hono } from "hono";

// Replace with your webhook endpoint's signing secret.
const MXRAVEN_WEBHOOK_SECRET = "whsec_your-signing-secret";

const webhook = new WebhookHandler({ secret: MXRAVEN_WEBHOOK_SECRET });

webhook.on(eventType.inboundEmail, (email) => {
  console.log(`inbound ${email.task_id}: ${email.message.subject ?? "(no subject)"}`);
});

webhook.on(eventType.deliveryStatus, (status) => {
  console.log(`delivery ${status.task_id}: ${status.status}`);
});

// Hono exposes a Fetch API Request, so the handler is passed through directly.
// This default export runs on Cloudflare Workers, Deno, and Bun; on Node, wrap
// the app with @hono/node-server.
const app = new Hono();
app.post("/mxraven/webhook", (c) => webhook.handle(c.req.raw));

export default app;
