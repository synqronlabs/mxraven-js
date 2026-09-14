/**
 * SMTP session state and transport errors.
 *
 * These errors are internal to the SDK. Server replies are reported with the
 * public {@link SMTPError}; the errors here report connection and session
 * state problems that are not tied to a reply code.
 *
 * @internal
 */

import type { TransactionResult } from "./transaction.js";

/** The category of an {@link SmtpSessionError}. */
export const smtpSessionErrorKind = {
  /** The session has already been closed. */
  clientClosed: "client-closed",
  /** No connection has been established. */
  noConnection: "no-connection",
  /** The connection was closed by the peer. */
  connectionClosed: "connection-closed",
  /** The server did not advertise a required extension. */
  extensionNotSupported: "extension-not-supported",
  /** Authentication failed. */
  authFailed: "auth-failed",
  /** No credentials were configured for authentication. */
  noCredentials: "no-credentials",
  /** The requested authentication mechanism is not supported. */
  unsupportedMechanism: "unsupported-mechanism",
  /** The envelope has no recipients. */
  noRecipients: "no-recipients",
  /** The transaction failed because every recipient was rejected. */
  transactionFailed: "transaction-failed",
  /** The server refused the DATA command. */
  dataFailed: "data-failed",
  /** The server does not support the requested DELIVERBY extension. */
  deliveryByNotSupported: "delivery-by-not-supported",
  /** The connection is already protected by TLS. */
  tlsAlreadyActive: "tls-already-active",
  /** The server does not support STARTTLS. */
  tlsNotSupported: "tls-not-supported",
  /** The server sent a malformed response. */
  unexpectedResponse: "unexpected-response",
} as const;

/** The category of an {@link SmtpSessionError}. */
export type SmtpSessionErrorKind = (typeof smtpSessionErrorKind)[keyof typeof smtpSessionErrorKind];

/** Reports a connection or session state failure. */
export class SmtpSessionError extends Error {
  /** The failure category. */
  readonly kind: SmtpSessionErrorKind;

  /**
   * @param kind - The failure category.
   * @param message - A human-readable description.
   * @param options - An optional cause.
   */
  constructor(kind: SmtpSessionErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SmtpSessionError";
    this.kind = kind;
  }
}

/** Reports that an SMTP operation exceeded its deadline. */
export class SmtpTimeoutError extends Error {
  /**
   * @param operation - The operation that timed out.
   */
  constructor(operation: string) {
    super(`smtp: ${operation} timed out`);
    this.name = "SmtpTimeoutError";
  }
}

/** Reports an aborted SMTP operation. */
export class SmtpAbortError extends Error {
  /**
   * @param options - The abort cause.
   */
  constructor(options?: { cause?: unknown }) {
    super("smtp: operation aborted", options);
    this.name = "SmtpAbortError";
  }
}

/** Reports a transaction failure that still has per-recipient results. */
export class SmtpTransactionError extends SmtpSessionError {
  /** The per-recipient results collected before the failure. */
  readonly result: TransactionResult;

  /**
   * @param message - A human-readable description.
   * @param result - The partial transaction result.
   */
  constructor(message: string, result: TransactionResult) {
    super(smtpSessionErrorKind.transactionFailed, message);
    this.name = "SmtpTransactionError";
    this.result = result;
  }
}
