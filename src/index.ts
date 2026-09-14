/**
 * TypeScript SDK for the mxRaven mail-facing runtime surfaces.
 *
 * The package submits email through the mxRaven SMTP submission service and
 * provides runtime helpers for webhook verification and recipient feedback. It
 * mirrors the Go SDK at
 * {@link https://github.com/synqronlabs/mxraven-go/tree/main/mail}.
 *
 * @packageDocumentation
 */

export { Client, defaultAddressPort } from "./client.js";
export type { ClientOptions, SendOptions } from "./client.js";
export { SMTPError, SMTPTransactionError } from "./errors.js";
export { Message } from "./message.js";
export type { Attachment, Envelope, Header } from "./message.js";
export type { RecipientResult, Result } from "./result.js";
