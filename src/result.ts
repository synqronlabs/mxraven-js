/**
 * Describes the outcome of a submission that reached the server.
 *
 * @public
 */
export interface Result {
  /**
   * The mxRaven message reference from the server's final `message_ref=<uuid>` reply. It is empty
   * when the server did not report one.
   */
  readonly messageRef: string;

  /** The three-digit SMTP reply code of the final reply. */
  readonly code: number;

  /** The final SMTP reply text. It is intended for humans and is not stable. */
  readonly message: string;

  /**
   * Per-recipient acceptance. It is populated when the server returned individual `RCPT TO`
   * responses.
   */
  readonly recipients: readonly RecipientResult[];
}

/**
 * Reports whether a single envelope recipient was accepted.
 *
 * @public
 */
export interface RecipientResult {
  /** The recipient address as submitted. */
  readonly address: string;

  /** Whether the server accepted the recipient. */
  readonly accepted: boolean;

  /** The rejection reason when {@link RecipientResult.accepted} is `false`. */
  readonly error?: Error;
}

/**
 * Extracts the mxRaven message reference from a final `DATA` reply.
 *
 * The submission service appends a message reference to its reply, for example
 * `250 2.0.0 accepted; message_ref=<uuid>`.
 *
 * @param message - The final reply text.
 * @returns The message reference, or an empty string when the reply has none.
 * @internal
 */
export function parseMessageRef(message: string): string {
  const key = "message_ref=";
  const index = message.indexOf(key);
  if (index < 0) {
    return "";
  }
  let value = message.slice(index + key.length).trim();
  value = value.replace(/^</, "");
  const end = value.search(/[>;\s]/);
  if (end >= 0) {
    value = value.slice(0, end);
  }
  return value;
}
