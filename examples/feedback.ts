// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { readFile } from "node:fs/promises";

import { Client } from "@mxraven/mail/feedback";

// Replace these with your submission credentials from the mxRaven dashboard.
const MXRAVEN_FEEDBACK_URL = "https://feedback.mxraven.email";
const MXRAVEN_USERNAME = "mxr_tx_ab12cd34ef56";
const MXRAVEN_SECRET = "your-submission-secret";

// The exact raw bytes mxRaven processed; a mismatch returns a 404.
const MESSAGE_PATH = "message.eml";

const feedback = new Client({
  baseUrl: MXRAVEN_FEEDBACK_URL,
  username: MXRAVEN_USERNAME,
  secret: MXRAVEN_SECRET,
});

const rawMessage = await readFile(MESSAGE_PATH);
const result = await feedback.learnSpam(rawMessage);
console.log("learned", result.disposition, "for listener", result.listenerId);

// RFC 8058 one-click unsubscribe does not use credentials:
// await feedback.unsubscribe(token);
