/**
 * SASL mechanism selection and encoding.
 *
 * Only `PLAIN` and `LOGIN` are supported, matching the submission service.
 *
 * @internal
 */

import { Buffer } from "node:buffer";

/**
 * Selects an authentication mechanism the server also advertises.
 *
 * When the caller provides preferred mechanisms they are tried in order;
 * otherwise `PLAIN` is preferred over `LOGIN`, matching the server's own
 * capability ordering.
 *
 * @param preferred - Client-preferred mechanisms, in order.
 * @param serverMechanisms - Mechanisms advertised by the server.
 * @returns The selected mechanism in uppercase, or an empty string.
 */
export function selectAuthMechanism(
  preferred: readonly string[],
  serverMechanisms: readonly string[],
): string {
  if (preferred.length > 0) {
    for (const candidate of preferred) {
      if (serverMechanisms.some((server) => server.toLowerCase() === candidate.toLowerCase())) {
        return candidate.toUpperCase();
      }
    }
    return "";
  }

  for (const candidate of ["PLAIN", "LOGIN"]) {
    if (serverMechanisms.some((server) => server.toLowerCase() === candidate.toLowerCase())) {
      return candidate;
    }
  }
  return "";
}

/**
 * Encodes `PLAIN` credentials as `\0username\0password`.
 *
 * @param username - The submission key username.
 * @param password - The submission key secret.
 * @returns The Base64-encoded SASL payload.
 */
export function encodePlainAuth(username: string, password: string): string {
  return Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
}

/**
 * Encodes one `LOGIN` step.
 *
 * @param value - The username or password.
 * @returns The Base64-encoded value.
 */
export function encodeLoginAuth(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
