// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { WebhookError, Verifier } from "@mxraven/mail/webhook";
import { Hono } from "hono";

// Replace with the signing secret of the endpoint your routing script calls
// with mx.http.
const MXRAVEN_ENDPOINT_SECRET = "whsec_your-signing-secret";

const verifier = new Verifier({ secret: MXRAVEN_ENDPOINT_SECRET });

// Hono exposes a Fetch API Request, so verification takes it directly. This
// default export runs on Cloudflare Workers, Deno, and Bun; on Node, wrap the
// app with @hono/node-server.
const app = new Hono();
app.post("/mxraven/risk-check", async (c) => {
  try {
    await verifier.verify(c.req.raw);
  } catch (error) {
    const status = error instanceof WebhookError ? error.status : 500;
    return c.body(null, status);
  }

  const payload = await c.req.json();
  console.log("risk check for", payload.from);
  return c.json({ verdict: "allow" });
});

export default app;
