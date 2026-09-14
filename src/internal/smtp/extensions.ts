/**
 * SMTP extension parsing and capability inspection.
 *
 * @internal
 */

/** Extension names advertised in an EHLO reply. */
export const smtpExtension = {
  /** `SIZE`, with the maximum message size as its parameter. */
  size: "SIZE",
  /** `PIPELINING`. */
  pipelining: "PIPELINING",
  /** `8BITMIME`. */
  eightBitMime: "8BITMIME",
  /** `AUTH`, with the supported mechanisms as its parameter. */
  auth: "AUTH",
  /** `STARTTLS`. */
  startTls: "STARTTLS",
  /** `ENHANCEDSTATUSCODES`. */
  enhancedStatusCodes: "ENHANCEDSTATUSCODES",
  /** `SMTPUTF8`. */
  smtpUtf8: "SMTPUTF8",
  /** `DSN`. */
  dsn: "DSN",
  /** `CHUNKING`. */
  chunking: "CHUNKING",
  /** `BINARYMIME`. */
  binaryMime: "BINARYMIME",
  /** `DELIVERBY`, with the minimum interval in seconds as its parameter. */
  deliverBy: "DELIVERBY",
  /** `REQUIRETLS` (RFC 8689). */
  requireTls: "REQUIRETLS",
} as const;

/** A server extension name. */
export type SmtpExtension = (typeof smtpExtension)[keyof typeof smtpExtension];

/** A read-only view of the extensions advertised by the server. */
export interface SmtpCapabilities {
  /** Whether the server accepted EHLO. */
  readonly isEsmtp: boolean;
  /** The server hostname from the EHLO reply, when one was present. */
  readonly hostname: string;
  /** Whether `STARTTLS` is advertised. */
  readonly tls: boolean;
  /** Whether `PIPELINING` is advertised. */
  readonly pipelining: boolean;
  /** Whether `8BITMIME` is advertised. */
  readonly eightBitMime: boolean;
  /** Whether `SMTPUTF8` is advertised. */
  readonly smtpUtf8: boolean;
  /** Whether `DSN` is advertised. */
  readonly dsn: boolean;
  /** Whether `CHUNKING` is advertised. */
  readonly chunking: boolean;
  /** Whether `BINARYMIME` is advertised. */
  readonly binaryMime: boolean;
  /** Whether `ENHANCEDSTATUSCODES` is advertised. */
  readonly enhancedStatusCodes: boolean;
  /** Whether `DELIVERBY` is advertised. */
  readonly deliveryBy: boolean;
  /** The minimum `DELIVERBY` interval in seconds, or 0. */
  readonly deliveryByMinSeconds: number;
  /** The maximum message size in bytes, or 0 when not advertised. */
  readonly maxSize: number;
  /** The authentication mechanisms advertised by the server. */
  readonly auth: readonly string[];
  /** Reports whether an extension was advertised. */
  hasExtension(name: string): boolean;
  /** Returns an extension's parameter, or an empty string. */
  getExtensionParam(name: string): string;
  /** Reports whether the server advertised an authentication mechanism. */
  supportsAuth(mechanism: string): boolean;
}

/**
 * Parses EHLO reply lines into an extension map.
 *
 * The first line carries the server greeting and is ignored; each subsequent
 * line is `NAME` or `NAME params`.
 *
 * @param lines - The EHLO reply text lines.
 * @returns The advertised extensions keyed by uppercase name.
 */
export function parseExtensions(lines: readonly string[]): Map<string, string> {
  const extensions = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(" ");
    if (separator === -1) {
      extensions.set(line.toUpperCase(), "");
    } else {
      extensions.set(line.slice(0, separator).toUpperCase(), line.slice(separator + 1));
    }
  }
  return extensions;
}

/**
 * Builds a capability view over an extension map.
 *
 * @param extensions - The extensions keyed by uppercase name.
 * @param isEsmtp - Whether EHLO succeeded.
 * @param hostname - The server hostname from the EHLO reply.
 * @returns A read-only capability view.
 */
export function capabilitiesFrom(
  extensions: ReadonlyMap<string, string>,
  isEsmtp: boolean,
  hostname: string,
): SmtpCapabilities {
  const getExtensionParam = (name: string): string => extensions.get(name.toUpperCase()) ?? "";
  const hasExtension = (name: string): boolean => extensions.has(name.toUpperCase());
  const auth = getExtensionParam(smtpExtension.auth)
    .split(/\s+/)
    .filter((value) => value !== "");

  return {
    isEsmtp,
    hostname,
    tls: hasExtension(smtpExtension.startTls),
    pipelining: hasExtension(smtpExtension.pipelining),
    eightBitMime: hasExtension(smtpExtension.eightBitMime),
    smtpUtf8: hasExtension(smtpExtension.smtpUtf8),
    dsn: hasExtension(smtpExtension.dsn),
    chunking: hasExtension(smtpExtension.chunking),
    binaryMime: hasExtension(smtpExtension.binaryMime),
    enhancedStatusCodes: hasExtension(smtpExtension.enhancedStatusCodes),
    deliveryBy: hasExtension(smtpExtension.deliverBy),
    deliveryByMinSeconds: parsePositiveInt(getExtensionParam(smtpExtension.deliverBy)),
    maxSize: parsePositiveInt(getExtensionParam(smtpExtension.size)),
    auth,
    hasExtension,
    getExtensionParam,
    supportsAuth: (mechanism) =>
      auth.some((advertised) => advertised.toLowerCase() === mechanism.toLowerCase()),
  };
}

/** Parses a non-negative decimal integer, returning 0 when invalid. */
function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
