// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { NotificationClient, fetchRawEmail, stopConsuming } from "@mxraven/mail/notify";

// Replace these with the listener API key and listener ID from the dashboard.
const MXRAVEN_NATS_URL = "wss://notifications.mxraven.com";
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
      const { accepted } = event;
      console.log(
        "accepted",
        accepted.taskId,
        accepted.message.subject,
        accepted.routingDecision.terminalAction,
      );
      for (const line of accepted.routingDecision.log) {
        console.log("script:", line);
      }
      if (accepted.rawEmail.accessToken !== "") {
        // MTA listeners can download the exact spooled message.
        const bytes = await fetchRawEmail(accepted.rawEmail);
        console.log("raw message bytes:", bytes.byteLength);
      }
      return;
    }

    if (event.kind === "fault") {
      // An MTA script fault defers the message with a 451, so the fault arrives
      // here rather than on an accepted event. Fault events are sampled.
      console.warn(
        "script fault",
        event.fault.fault.reason,
        event.fault.fault.message,
        "suppressed:",
        event.fault.suppressedFaults,
      );
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
