/**
 * ASCII inspection helpers shared by the address and domain parsers.
 *
 * @internal
 */

/** Reports whether a string contains a non-ASCII code unit. */
export function containsNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) >= 0x80) {
      return true;
    }
  }
  return false;
}
