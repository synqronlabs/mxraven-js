import type { Result } from "./result.js";

/**
 * The reason a mailbox address was rejected.
 *
 * Each value corresponds to a distinct, programmatically recognizable failure,
 * so callers can decide whether to retry, ask the user to fix the address, or
 * drop it.
 *
 * @public
 */
export const addressErrorKind = {
  /** The input is not a single valid mailbox address. */
  invalidAddress: "invalid-address",
  /** The address has no `@` separating the local part from the domain. */
  missingAt: "missing-at",
  /** The local part is empty, as in `@example.com`. */
  localPartEmpty: "local-part-empty",
  /** The local part is not valid dot-atom or quoted-string syntax. */
  invalidLocalPart: "invalid-local-part",
  /** The domain is empty, as in `user@`. */
  domainEmpty: "domain-empty",
  /** The domain is not a valid DNS name or internationalized domain. */
  invalidDomain: "invalid-domain",
  /** The domain literal is not a valid IP address or general address literal. */
  invalidDomainLiteral: "invalid-domain-literal",
  /** The local part exceeds the 64-octet limit from RFC 5321. */
  localPartTooLong: "local-part-too-long",
  /** The domain exceeds the 255-octet limit from RFC 5321. */
  domainTooLong: "domain-too-long",
  /** The complete address exceeds the 254-octet limit from RFC 5321. */
  addressTooLong: "address-too-long",
  /** The input contains an unpaired surrogate and is not valid UTF-8. */
  invalidUtf8: "invalid-utf8",
  /** The input contains a bare line break or a fold without trailing whitespace. */
  invalidLineEnding: "invalid-line-ending",
  /** A quoted string, comment, or display name contains a control character. */
  invalidHeaderValue: "invalid-header-value",
  /** A display name uses an RFC 2047 character set that cannot be decoded. */
  unsupportedCharset: "unsupported-charset",
} as const;

/** The reason a mailbox address was rejected. */
export type AddressErrorKind = (typeof addressErrorKind)[keyof typeof addressErrorKind];

/**
 * A mailbox address that could not be parsed.
 *
 * Instances carry a stable {@link AddressError.kind} so callers can branch on
 * the failure without matching message text. Errors raised while validating a
 * {@link Message} are collected in an `AggregateError` and keep their kind.
 *
 * @example
 * ```ts
 * try {
 *   await client.send(new Message().from("noreply@acme.example").to(input));
 * } catch (error) {
 *   if (error instanceof AggregateError) {
 *     for (const problem of error.errors) {
 *       if (problem instanceof AddressError && problem.kind === addressErrorKind.invalidDomain) {
 *         // The domain is not resolvable as a DNS name.
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * @public
 */
export class AddressError extends Error {
  /** The classified reason the address was rejected. */
  readonly kind: AddressErrorKind;

  /**
   * @param options - The failure kind, a human-readable description, and the
   * underlying error when this error wraps one.
   */
  constructor(options: { kind: AddressErrorKind; message: string; cause?: unknown }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AddressError";
    this.kind = options.kind;
  }
}

/**
 * An SMTP reply that rejected a submission.
 *
 * It is thrown when the server refuses a command, for example when the sender
 * domain is not authorized or a recipient is rejected. Inspect {@link SMTPError.code}
 * or {@link SMTPError.enhancedCode} to make a delivery decision; the `message`
 * is intended for humans and is not stable.
 *
 * @public
 */
export class SMTPError extends Error {
  /** The three-digit SMTP reply code. */
  readonly code: number;

  /** The RFC 3463 enhanced status code, when the server supplied one. */
  readonly enhancedCode?: string;

  /** @param options - The reply code, optional enhanced code, and reply text. */
  constructor(options: { code: number; enhancedCode?: string; message: string }) {
    super(options.message);
    this.name = "SMTPError";
    this.code = options.code;
    this.enhancedCode = options.enhancedCode;
  }

  /** Reports whether the failure is permanent (5xx). Retrying is unlikely to succeed. */
  get permanent(): boolean {
    return this.code >= 500 && this.code < 600;
  }

  /** Reports whether the failure is transient (4xx). The message may be retried later. */
  get transient(): boolean {
    return this.code >= 400 && this.code < 500;
  }
}

/**
 * The submission server did not advertise the `DELIVERBY` extension, so a
 * requested delivery deadline (RFC 2852) cannot be honored.
 *
 * This is a local capability failure, not an SMTP reply; it is thrown before
 * the transaction starts.
 *
 * @public
 */
export class DeliveryByUnsupportedError extends Error {
  constructor() {
    super("mail: server does not support DELIVERBY");
    this.name = "DeliveryByUnsupportedError";
  }
}

/**
 * A submission the server rejected after per-recipient results were collected.
 *
 * It is thrown when every envelope recipient was rejected. The per-recipient
 * detail remains available in {@link SMTPTransactionError.result}.
 *
 * @public
 */
export class SMTPTransactionError extends Error {
  /** The per-recipient results collected before the failure. */
  readonly result: Result;

  /**
   * @param message - A human-readable description.
   * @param result - The partial submission result.
   */
  constructor(message: string, result: Result) {
    super(message);
    this.name = "SMTPTransactionError";
    this.result = result;
  }
}
