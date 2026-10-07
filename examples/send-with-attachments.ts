// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { readFile } from "node:fs/promises";

import { Client, Message } from "@mxraven/mail";

// Replace these with your submission credentials from the mxRaven dashboard.
const MXRAVEN_SMTP_HOST = "smtp.mxraven.email";
const MXRAVEN_USERNAME = "mxr_tx_ab12cd34ef56";
const MXRAVEN_SECRET = "your-submission-secret";

const INVOICE_PATH = "invoice.pdf";
const LOGO_PATH = "logo.png";

const client = new Client({
  host: MXRAVEN_SMTP_HOST,
  username: MXRAVEN_USERNAME,
  secret: MXRAVEN_SECRET,
});

const invoice = await readFile(INVOICE_PATH);
const logo = await readFile(LOGO_PATH);

const message = new Message()
  .from("Acme <noreply@acme.example>")
  .to("customer@example.com")
  .subject("Your invoice")
  .text("Your invoice is attached.")
  .html('<p>Your invoice is attached.</p><img src="cid:logo" alt="Acme">')
  // Regular attachment.
  .attach({ filename: "invoice.pdf", contentType: "application/pdf", data: invoice })
  // Inline attachment for the cid: reference above.
  .attachInline("logo.png", "logo", logo);

const result = await client.send(message, { signal: AbortSignal.timeout(30_000) });

console.log("queued as", result.messageRef);
for (const recipient of result.recipients) {
  console.log(`  ${recipient.address}: ${recipient.accepted ? "accepted" : "rejected"}`);
}

await client.close();
