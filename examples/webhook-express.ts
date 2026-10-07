// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { WebhookHandler, eventType } from "@mxraven/mail/webhook";
import express from "express";

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

const app = express();
app.set("trust proxy", true); // honor X-Forwarded-Proto/Host behind a proxy

// express.raw() keeps the exact bytes on req.body and must be mounted before
// any express.json() parser. Express 5 awaits async handlers.
app.post("/mxraven/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const response = await webhook.handle({
    method: req.method,
    url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    headers: req.headers,
    body: req.body,
  });
  res.sendStatus(response.status);
});

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}/mxraven/webhook`);
});
