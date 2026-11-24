// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { WebhookError, Verifier, webhookHeaders } from "@mxraven/mail/webhook";
import express from "express";

// Replace with the signing secret of the endpoint your routing script calls
// with mx.http. The secret is shown once when the endpoint is created or its
// secret is rotated.
const MXRAVEN_ENDPOINT_SECRET = "whsec_your-signing-secret";
const PORT = 3000;

const verifier = new Verifier({ secret: MXRAVEN_ENDPOINT_SECRET });

const app = express();
app.set("trust proxy", true); // honor X-Forwarded-Proto/Host behind a proxy

// express.raw() keeps the exact bytes on req.body and must be mounted before
// any express.json() parser. Express 5 awaits async handlers.
app.post("/mxraven/risk-check", express.raw({ type: "*/*" }), async (req, res) => {
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

  // The script decides the body; this endpoint owns its schema.
  const payload = JSON.parse(req.body.toString("utf8"));
  console.log(
    "call from listener",
    req.get(webhookHeaders.listener),
    "revision",
    req.get(webhookHeaders.revision),
    payload.from,
  );

  // A 200 with a JSON verdict: mx.http exposes status, headers, body, and json.
  res.status(200).json({ verdict: "allow" });
});

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}/mxraven/risk-check`);
});
