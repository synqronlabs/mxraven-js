// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { NotificationClient, stopConsuming } from "@mxraven/mail/notify";

// Replace these with the listener API key and listener ID from the dashboard.
const MXRAVEN_NATS_URL = "wss://nats.mxraven.com";
const MXRAVEN_USERNAME = "mxr_tx_ab12cd34ef56";
const MXRAVEN_SECRET = "your-api-key-secret";
const LISTENER_ID = "0b0b0b0b-1111-2222-3333-444444444444";

// Notifications must be enabled for the listener before connecting.
const client = await NotificationClient.connect({
  url: MXRAVEN_NATS_URL,
  username: MXRAVEN_USERNAME,
  secret: MXRAVEN_SECRET,
  listener: LISTENER_ID,
});

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

await client.consume(
  async (event) => {
    if (event.kind === "accepted") {
      console.log("accepted", event.accepted.task_id, event.accepted.message.subject);
      if (event.accepted.raw_email.access_token !== "") {
        // MTA listeners can download the message with fetchRawEmail from
        // @mxraven/mail/webhook.
        console.log("raw message:", event.accepted.raw_email.url);
      }
      return;
    }

    console.log(
      "attempt",
      event.attempt.channel,
      event.attempt.taskId,
      event.attempt.status,
      event.attempt.reason ?? "",
    );

    if (event.attempt.status === "failed") {
      // Returning stopConsuming acknowledges this event and ends consumption.
      return stopConsuming;
    }
  },
  { signal: controller.signal },
);

await client.close();
