// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { Client, Message } from "@mxraven/mail";
import { react } from "@mxraven/react";

// Replace these with your submission credentials from the mxRaven dashboard.
const MXRAVEN_SMTP_HOST = "smtp.mxraven.email";
const MXRAVEN_USERNAME = "mxr_tx_ab12cd34ef56";
const MXRAVEN_SECRET = "your-submission-secret";

function Welcome({ firstName }: { firstName: string }) {
  return (
    <div>
      <h1>Welcome, {firstName}!</h1>
      <p>Thanks for signing up. Reply to this email if you need anything.</p>
    </div>
  );
}

const client = new Client({
  host: MXRAVEN_SMTP_HOST,
  username: MXRAVEN_USERNAME,
  secret: MXRAVEN_SECRET,
});

// The renderer runs on the server inside send(), so async components work.
const result = await client.send(
  new Message()
    .from("Acme <noreply@acme.example>")
    .to("customer@example.com")
    .subject("Welcome")
    .render(react(), <Welcome firstName="mxRaven" />),
);

console.log("queued as", result.messageRef);
await client.close();
