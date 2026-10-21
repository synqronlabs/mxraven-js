/**
 * Internationalized domain name mapping and Punycode encoding.
 *
 * `toAsciiDomain` converts a Unicode domain name into its ASCII (A-label) form
 * using the subset of {@link https://www.unicode.org/reports/tr46/} (UTS #46)
 * and {@link https://datatracker.ietf.org/doc/html/rfc3492} (Punycode) that the
 * Go SDK's `golang.org/x/net/idna` profile accepts. Non-ASCII labels are mapped,
 * validated, and Punycode-encoded; ASCII labels are validated and lowercased.
 *
 * @remarks
 * The mapping approximates the UTS #46 `MapForLookup` profile without shipping
 * Unicode data tables. Normalization uses `NFKC` plus per-code-point
 * lowercasing, which matches the Go profile for realistic domain names. Three
 * deliberate differences remain, all documented on {@link toAsciiDomain}:
 * bidirectional rules are not applied, joiner contexts are rejected outright
 * rather than validated, and the small negative `UseSTD3ASCIIRules` character
 * set is not modelled.
 *
 * @internal
 */

/** The Punycode base (radix) for the variable-length integer encoding. */
const BASE = 36;

/** The lower bound of the adaptive threshold. */
const TMIN = 1;

/** The upper bound of the adaptive threshold. */
const TMAX = 26;

/** The skew applied to the adaptive threshold. */
const SKEW = 38;

/** The damping factor applied to the adaptive threshold. */
const DAMP = 700;

/** The initial adaptive threshold bias. */
const INITIAL_BIAS = 72;

/** The first code point that requires an escape sequence. */
const INITIAL_N = 0x80;

/** The Punycode delimiter between the literal and encoded parts. */
const DELIMITER = "-";

/** The ACE prefix for an A-label. */
const ACE_PREFIX = "xn--";

/** The maximum integer representable by a JavaScript bitwise operation. */
const MAX_INT = 0x7fffffff;

/** The maximum length of a DNS label, in octets. */
const MAX_LABEL_LENGTH = 63;

/** Code point ranges that UTS #46 maps to nothing. */
const IGNORABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x180b, 0x180d],
  [0x200b, 0x200b],
  [0x2060, 0x2064],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

/** Code points that UTS #46 maps to something other than their case-folded form. */
const SPECIAL_MAPPINGS = new Map([[0x1e9e, "ss"]]);

/**
 * Code points that are prohibited regardless of label position.
 *
 * Unicode categories `Cc` (control), `Cf` (format), `Cs` (surrogate), `Co`
 * (private use), `Cn` (unassigned), and `Z` (separator) are disallowed by
 * UTS #46, as are the replacement characters. `Cf` code points that UTS #46
 * ignores are removed before this check.
 */
const DISALLOWED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}\uFFFC\uFFFD]/u;

/** A combining mark, which may not begin an internationalized label. */
const COMBINING_MARK = /\p{M}/u;

/** ASCII characters permitted in a label after mapping. */
const ASCII_LABEL = /^[a-z0-9-]+$/;

/** Characters that UTS #46 maps to a label separator. */
const SEPARATORS = new Set([0x3002, 0xff0e, 0xff61]);

/** Reports whether UTS #46 maps a code point to nothing. */
function isIgnorable(codePoint: number): boolean {
  return IGNORABLE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * Converts a Unicode domain name into its ASCII (A-label) form.
 *
 * The domain is expected to be a bare domain name — not a domain literal.
 * Internationalized labels are mapped to their ASCII form and every label is
 * lowercased, mirroring the Go SDK's normalization of header-context domains.
 *
 * @param domain - The domain to normalize. It must not be empty.
 * @returns The ASCII domain, or `undefined` when the domain is not a valid
 * internationalized domain name.
 *
 * @remarks
 * Deliberate differences from the Go profile, all limited to inputs that are
 * invalid or vanishingly rare on the wire:
 *
 * - Bidirectional (RTL) rules are not applied, so mixed-direction labels that
 *   Go accepts are accepted here as well.
 * - Zero-width joiners are rejected instead of validated against their
 *   contextual rules.
 * - The `UseSTD3ASCIIRules` restriction is not modelled, which matches the Go
 *   profile's settings.
 *
 * @internal
 */
export function toAsciiDomain(domain: string): string | undefined {
  const mapped = mapDomain(domain);
  const labels = mapped.split(".");
  const ascii: string[] = [];
  for (const label of labels) {
    const converted = convertLabel(label);
    if (converted === undefined) {
      return undefined;
    }
    ascii.push(converted);
  }
  return ascii.join(".");
}

/**
 * Applies the UTS #46 mapping to a domain name.
 *
 * Ignorable code points are dropped, label separators become `.`, and the
 * remaining code points are compatibility-normalized and lowercased.
 */
function mapDomain(input: string): string {
  let output = "";
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (isIgnorable(codePoint)) {
      continue;
    }
    if (SEPARATORS.has(codePoint)) {
      output += ".";
      continue;
    }
    const special = SPECIAL_MAPPINGS.get(codePoint);
    if (special !== undefined) {
      output += special;
      continue;
    }
    output += lowercase(normalize(char));
  }
  return output.normalize("NFC");
}

/** Compatibility-normalizes a single code point. */
function normalize(char: string): string {
  return char.normalize("NFKC");
}

/**
 * Lowercases one code point at a time.
 *
 * Lowercasing per code point avoids the context-sensitive Greek final sigma
 * rule, matching the rune-wise case mapping the Go profile applies.
 */
function lowercase(value: string): string {
  let output = "";
  for (const char of value) {
    output += char.toLowerCase();
  }
  return output;
}

/** Converts one mapped label to its ASCII form. */
function convertLabel(label: string): string | undefined {
  if (label === "") {
    return undefined;
  }
  if (DISALLOWED.test(label)) {
    return undefined;
  }

  if (label.startsWith(ACE_PREFIX)) {
    return validateALabel(label);
  }

  // Every ASCII character of a U-label must be a letter, digit, or hyphen;
  // UTS #46 disallows ASCII punctuation even next to non-ASCII code points.
  for (const char of label) {
    if ((char.codePointAt(0) ?? 0) < INITIAL_N && !ASCII_LABEL.test(char)) {
      return undefined;
    }
  }

  if (!isValidLabelText(label)) {
    return undefined;
  }
  const encoded = isAscii(label) ? label : encodePunycode(label);
  if (encoded === undefined || encoded.length > MAX_LABEL_LENGTH - ACE_PREFIX.length) {
    return undefined;
  }
  return isAscii(label) ? encoded : `${ACE_PREFIX}${encoded}`;
}

/** Validates an A-label and returns its lowercased ASCII form. */
function validateALabel(label: string): string | undefined {
  const decoded = decodePunycode(label.slice(ACE_PREFIX.length));
  if (decoded === undefined || isAscii(decoded) || DISALLOWED.test(decoded)) {
    // UTS #46 requires an A-label to decode to a non-ASCII U-label.
    return undefined;
  }
  if (!isValidLabelText(decoded)) {
    return undefined;
  }
  const encoded = encodePunycode(decoded);
  if (encoded === undefined || encoded.length + ACE_PREFIX.length > MAX_LABEL_LENGTH) {
    return undefined;
  }
  return `${ACE_PREFIX}${encoded}`;
}

/**
 * Applies the structural label rules shared by U- and A-labels.
 *
 * A label must not begin or end with a hyphen, must not carry a hyphen in
 * positions three and four (which is reserved for the `xn--` prefix), and must
 * not begin with a combining mark.
 */
function isValidLabelText(label: string): boolean {
  if (label.startsWith("-") || label.endsWith("-")) {
    return false;
  }
  if (label.slice(2, 4) === "--" && !label.startsWith(ACE_PREFIX)) {
    return false;
  }
  const first = Array.from(label)[0];
  return first !== undefined && !COMBINING_MARK.test(first);
}

/** Reports whether a string contains only ASCII code units. */
function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) >= INITIAL_N) {
      return false;
    }
  }
  return true;
}

/** Returns the Punycode digit for a numeric value. */
function encodeDigit(digit: number): string {
  return String.fromCharCode(digit < 26 ? digit + 0x61 : digit + 0x16);
}

/** Returns the numeric value of a Punycode digit, or `-1` when invalid. */
function decodeDigit(codeUnit: number): number {
  if (codeUnit >= 0x30 && codeUnit <= 0x39) {
    return codeUnit - 0x30 + 26;
  }
  if (codeUnit >= 0x61 && codeUnit <= 0x7a) {
    return codeUnit - 0x61;
  }
  if (codeUnit >= 0x41 && codeUnit <= 0x5a) {
    return codeUnit - 0x41;
  }
  return -1;
}

/** Adapts the threshold bias after each encoded delta. */
function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let value = firstTime ? Math.floor(delta / DAMP) : delta >>> 1;
  value += Math.floor(value / numPoints);
  let k = 0;
  while (value > ((BASE - TMIN) * TMAX) >>> 1) {
    value = Math.floor(value / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * value) / (value + SKEW));
}

/**
 * Encodes a string using {@link https://datatracker.ietf.org/doc/html/rfc3492}
 * (Punycode).
 *
 * @param input - The code points to encode.
 * @returns The Punycode payload, without the `xn--` prefix, or `undefined` when
 * the input contains a lone surrogate or overflows the 31-bit delta space.
 *
 * @internal
 */
export function encodePunycode(input: string): string | undefined {
  const codePoints: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) {
      return undefined;
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return undefined;
    }
    if (codePoint > 0xffff) {
      index += 1;
    }
    codePoints.push(codePoint);
  }

  let output = "";
  let handled = 0;
  for (const codePoint of codePoints) {
    if (codePoint < INITIAL_N) {
      output += String.fromCharCode(codePoint);
      handled += 1;
    }
  }
  const basicCount = handled;
  if (basicCount > 0) {
    output += DELIMITER;
  }

  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < codePoints.length) {
    let next = MAX_INT;
    for (const codePoint of codePoints) {
      if (codePoint >= n && codePoint < next) {
        next = codePoint;
      }
    }
    if (next - n > Math.floor((MAX_INT - delta) / (handled + 1))) {
      return undefined;
    }
    delta += (next - n) * (handled + 1);
    n = next;

    for (const codePoint of codePoints) {
      if (codePoint < n) {
        delta += 1;
        if (delta > MAX_INT) {
          return undefined;
        }
        continue;
      }
      if (codePoint !== n) {
        continue;
      }
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
        if (q < t) {
          break;
        }
        output += encodeDigit(t + ((q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      output += encodeDigit(q);
      bias = adapt(delta, handled + 1, handled === basicCount);
      delta = 0;
      handled += 1;
    }

    delta += 1;
    n += 1;
  }

  return output;
}

/**
 * Decodes a {@link https://datatracker.ietf.org/doc/html/rfc3492} (Punycode)
 * payload.
 *
 * @param input - The payload, without the `xn--` prefix.
 * @returns The decoded Unicode label, or `undefined` when the payload is
 * malformed or not ASCII.
 *
 * @internal
 */
export function decodePunycode(input: string): string | undefined {
  if (input === "") {
    return "";
  }
  if (!isAscii(input)) {
    return undefined;
  }

  let output = "";
  let pos = 0;
  const delimiter = input.lastIndexOf(DELIMITER);
  if (delimiter >= 0) {
    output = input.slice(0, delimiter);
    pos = delimiter + 1;
  }

  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  while (pos < input.length) {
    const oldI = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (pos >= input.length) {
        return undefined;
      }
      const digit = decodeDigit(input.charCodeAt(pos));
      pos += 1;
      if (digit < 0) {
        return undefined;
      }
      if (digit > Math.floor((MAX_INT - i) / w)) {
        return undefined;
      }
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) {
        break;
      }
      if (w > Math.floor(MAX_INT / (BASE - t))) {
        return undefined;
      }
      w *= BASE - t;
    }

    const length = Array.from(output).length + 1;
    bias = adapt(i - oldI, length, oldI === 0);
    if (Math.floor(i / length) > MAX_INT - n) {
      return undefined;
    }
    n += Math.floor(i / length);
    i %= length;

    if (n > 0x10ffff) {
      return undefined;
    }
    const codePoints = Array.from(output);
    codePoints.splice(i, 0, String.fromCodePoint(n));
    output = codePoints.join("");
    i += 1;
  }

  return output;
}
