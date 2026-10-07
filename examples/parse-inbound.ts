// @ts-nocheck -- reference example, not covered by the SDK typecheck.
import { readFile } from "node:fs/promises";

import { parseEmail } from "@mxraven/mail/mime";

const MESSAGE_PATH = "message.eml";

const email = parseEmail(await readFile(MESSAGE_PATH));

console.log("subject:", email.subject ?? "(none)");
console.log("from:", email.from.map((address) => address.address).join(", "));
console.log("to:", email.to.map((address) => address.address).join(", "));
console.log("--- text ---");
console.log(email.text ?? "(no text body)");

for (const file of email.attachments) {
  console.log(
    `attachment: ${file.filename ?? "(unnamed)"} ${file.contentType} ${file.content.byteLength} bytes`,
  );
}
