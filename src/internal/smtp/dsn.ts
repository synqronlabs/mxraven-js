/**
 * RFC 3461 Delivery Status Notification parameter formatting.
 *
 * Only the encoding direction is needed when building commands, but xtext
 * parsing is included for symmetry and testing.
 *
 * @internal
 */

/** The maximum length of an `ENVID=` parameter, including the keyword. */
const MAX_ENVELOPE_ID_LENGTH = 100;

/** The maximum length of an `ORCPT=` parameter, including the keyword. */
const MAX_ORIGINAL_RECIPIENT_LENGTH = 500;

/**
 * Parses an RFC 3461 xtext value.
 *
 * @param wire - The encoded value.
 * @returns The decoded value.
 * @throws `Error` When the value contains invalid escapes or characters.
 */
export function parseXtext(wire: string): string {
  let decoded = "";
  for (let index = 0; index < wire.length;) {
    const char = wire[index] ?? "";
    if (char === "+") {
      if (index + 2 >= wire.length) {
        throw new Error("dsn: invalid xtext escape");
      }
      const high = fromHex(wire[index + 1] ?? "");
      const low = fromHex(wire[index + 2] ?? "");
      if (high === undefined || low === undefined) {
        throw new Error("dsn: invalid xtext escape");
      }
      decoded += String.fromCharCode((high << 4) | low);
      index += 3;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e || char === "=") {
      throw new Error("dsn: invalid xtext character");
    }
    decoded += char;
    index += 1;
  }
  return decoded;
}

/**
 * Encodes a value as RFC 3461 xtext.
 *
 * @param decoded - The value to encode.
 * @returns The encoded value.
 */
export function encodeXtext(decoded: string): string {
  let encoded = "";
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if (code >= 0x21 && code <= 0x7e && code !== 0x2b && code !== 0x3d) {
      encoded += decoded[index];
      continue;
    }
    encoded += `+${toHex(code >> 4)}${toHex(code & 0x0f)}`;
  }
  return encoded;
}

/**
 * Validates and upper-cases a `RET` value.
 *
 * @param value - `FULL` or `HDRS`, case-insensitively.
 * @returns The canonical value.
 * @throws `Error` When the value is not `FULL` or `HDRS`.
 */
export function normalizeDsnReturn(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("dsn: RET contains a line break");
  }
  const normalized = value.toUpperCase();
  if (normalized !== "FULL" && normalized !== "HDRS") {
    throw new Error("dsn: RET must be FULL or HDRS");
  }
  return normalized;
}

/**
 * Validates and upper-cases `NOTIFY` values.
 *
 * `NEVER` is valid only as the sole value.
 *
 * @param values - The values to normalize.
 * @returns The canonical values.
 * @throws `Error` When a value is invalid or `NEVER` is combined.
 */
export function normalizeDsnNotify(values: readonly string[]): string[] {
  if (values.length === 0) {
    throw new Error("dsn: NOTIFY value is empty");
  }
  const normalized: string[] = [];
  for (const value of values) {
    if (value === "" || /[\r\n]/.test(value)) {
      throw new Error("dsn: invalid NOTIFY value");
    }
    const upper = value.toUpperCase();
    if (upper !== "NEVER" && upper !== "SUCCESS" && upper !== "FAILURE" && upper !== "DELAY") {
      throw new Error(`dsn: invalid NOTIFY value ${JSON.stringify(value)}`);
    }
    normalized.push(upper);
  }
  if (normalized.includes("NEVER") && normalized.length !== 1) {
    throw new Error("dsn: NOTIFY NEVER must appear alone");
  }
  return normalized;
}

/**
 * Encodes a decoded envelope identifier as its `ENVID` wire value.
 *
 * @param decoded - The printable-ASCII envelope identifier.
 * @returns The encoded value, without the `ENVID=` prefix.
 * @throws `Error` When the value is empty, non-printable, or too long.
 */
export function formatDsnEnvelopeId(decoded: string): string {
  if (decoded === "" || !isPrintableAscii(decoded)) {
    throw new Error("dsn: invalid ENVID decoded value");
  }
  const wire = encodeXtext(decoded);
  if (wire.length + "ENVID=".length > MAX_ENVELOPE_ID_LENGTH) {
    throw new Error(`dsn: ENVID exceeds ${MAX_ENVELOPE_ID_LENGTH} characters`);
  }
  return wire;
}

/**
 * Encodes a decoded original recipient as its `ORCPT` wire value.
 *
 * @param addressType - The address type, for example `rfc822` or `utf-8`.
 * @param decoded - The decoded original recipient.
 * @param smtpUtf8 - Whether the session negotiated SMTPUTF8.
 * @returns The `address-type;encoded-address` value.
 * @throws `Error` When the address type or value is invalid.
 */
export function formatDsnOriginalRecipient(
  addressType: string,
  decoded: string,
  smtpUtf8: boolean,
): string {
  if (!isAtom(addressType)) {
    throw new Error("dsn: invalid ORCPT address type");
  }

  let encoded: string;
  if (addressType.toLowerCase() === "utf-8") {
    encoded = encodeUtf8Orcpt(decoded, smtpUtf8);
  } else {
    if (decoded === "" || !isPrintableAscii(decoded)) {
      throw new Error("dsn: invalid ORCPT decoded address");
    }
    encoded = encodeXtext(decoded);
  }

  const wire = `${addressType};${encoded}`;
  if (wire.length + "ORCPT=".length > MAX_ORIGINAL_RECIPIENT_LENGTH) {
    throw new Error(`dsn: ORCPT exceeds ${MAX_ORIGINAL_RECIPIENT_LENGTH} characters`);
  }
  return wire;
}

/** Encodes a UTF-8 original recipient using `\x{...}` escapes when needed. */
function encodeUtf8Orcpt(address: string, smtpUtf8: boolean): string {
  if (address === "" || /[\r\n]/.test(address)) {
    throw new Error("dsn: invalid UTF-8 ORCPT address");
  }
  let encoded = "";
  for (const char of address) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80 && isQChar(code)) {
      encoded += char;
      continue;
    }
    if (code >= 0x80 && smtpUtf8) {
      encoded += char;
      continue;
    }
    encoded += `\\x{${code.toString(16).toUpperCase()}}`;
  }
  return encoded;
}

/** Reports whether a string is non-empty printable US-ASCII. */
function isPrintableAscii(value: string): boolean {
  if (value === "") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
      return false;
    }
  }
  return true;
}

/** Reports whether a string is a valid RFC 3461 `atom`. */
function isAtom(value: string): boolean {
  if (value === "") {
    return false;
  }
  for (const char of value) {
    if (/[A-Za-z0-9]/.test(char) || "!#$%&'*+-/?^_`{|}~".includes(char)) {
      continue;
    }
    return false;
  }
  return true;
}

/** Reports whether a code point may appear literally in a UTF-8 ORCPT. */
function isQChar(code: number): boolean {
  return code >= 0x21 && code <= 0x7e && code !== 0x5c && code !== 0x2b && code !== 0x3d;
}

/** Converts one hexadecimal nibble to its uppercase character. */
function toHex(nibble: number): string {
  return nibble.toString(16).toUpperCase();
}

/** Converts one uppercase hexadecimal character to its value. */
function fromHex(char: string): number | undefined {
  if (char >= "0" && char <= "9") {
    return char.charCodeAt(0) - 0x30;
  }
  if (char >= "A" && char <= "F") {
    return char.charCodeAt(0) - 0x37;
  }
  return undefined;
}
