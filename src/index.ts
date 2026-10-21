/**
 * TypeScript SDK for the mxRaven mail-facing runtime surfaces.
 *
 * The package submits email through the mxRaven SMTP submission service and
 * provides runtime helpers for webhook verification, client notifications, and
 * recipient feedback. It mirrors the Go SDK at
 * {@link https://github.com/synqronlabs/mxraven-go/tree/main/mail}.
 *
 * @packageDocumentation
 */

export { parseAddress, parseAddressList } from "./address.js";
export type { MailboxAddress } from "./address.js";
export { Client, defaultAddressPort } from "./client.js";
export type { ClientOptions, SendOptions } from "./client.js";
export {
  AddressError,
  addressErrorKind,
  DeliveryByUnsupportedError,
  SMTPError,
  SMTPTransactionError,
} from "./errors.js";
export type { AddressErrorKind } from "./errors.js";
export { Message } from "./message.js";
export type {
  Attachment,
  DeliveryBy,
  DsnNotify,
  DsnReturn,
  Envelope,
  EnvelopeRecipient,
  Header,
  MediaType,
} from "./message.js";
export type { RecipientResult, Result } from "./result.js";
export type { RenderedTemplate, TemplateRenderer } from "./template.js";
