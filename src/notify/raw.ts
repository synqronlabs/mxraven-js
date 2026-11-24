/**
 * Downloads the raw message referenced by an accepted notification.
 */

import { createHash } from "node:crypto";

import { readBoundedBody } from "../internal/body.js";
import type { RawEmail } from "./accepted.js";

/** Bounds a download when the payload does not declare a size. */
const MAX_RAW_EMAIL_BYTES = 64 << 20;

/** A minimal `fetch`-compatible function. @public */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link fetchRawEmail}. @public */
export interface FetchRawEmailOptions {
  /** Cancels the download. */
  readonly signal?: AbortSignal;
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * Downloads the raw RFC 822 message referenced by an accepted notification.
 *
 * The payload's short-lived bearer token is sent in the `Authorization` header,
 * and the downloaded bytes are verified against the declared size and SHA-256
 * digest. The download requires a `200 OK` response. Raw-message access is
 * granted to MTA listeners only: on a submission listener's accepted event
 * every field is empty and there is nothing to download. Treat
 * `rawEmail.accessToken` as a secret and do not log it.
 *
 * @param raw - The `rawEmail` object from an accepted notification.
 * @param options - An optional cancellation signal and `fetch` implementation.
 * @returns The exact message bytes.
 * @throws `Error` When the URL or token is empty, the response is unsuccessful,
 * or the downloaded bytes fail the size or digest check.
 *
 * @example
 * ```ts
 * const bytes = await fetchRawEmail(event.accepted.rawEmail, { signal });
 * ```
 *
 * @public
 */
export async function fetchRawEmail(
  raw: RawEmail,
  options: FetchRawEmailOptions = {},
): Promise<Uint8Array> {
  const url = raw.url.trim();
  if (url === "") {
    throw new Error("raw email: URL is empty");
  }
  const token = raw.accessToken.trim();
  if (token === "") {
    throw new Error("raw email: access token is empty");
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const tokenType = (raw.tokenType ?? "").trim();
  const scheme = tokenType === "" ? "Bearer" : tokenType;

  const response = await fetcher(url, {
    method: "GET",
    headers: { Authorization: `${scheme} ${token}` },
    signal: options.signal,
  });
  if (response.status !== 200) {
    const statusText = response.statusText === "" ? "" : ` ${response.statusText}`;
    throw new Error(`raw email: fetch: unexpected status ${response.status}${statusText}`);
  }

  const size = raw.sizeBytes ?? 0;
  const limit = size > 0 ? size + 1 : MAX_RAW_EMAIL_BYTES;
  const body = await readBoundedBody({
    stream: response.body,
    limit,
    signal: options.signal,
    label: "raw email",
    tooLarge: (message) => new Error(message),
  });

  if (size > 0 && body.byteLength !== size) {
    throw new Error(`raw email: size = ${body.byteLength} bytes, want ${size}`);
  }

  const digest = (raw.sha256Hex ?? "").trim();
  if (digest !== "") {
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual.toLowerCase() !== digest.toLowerCase()) {
      throw new Error("raw email: SHA-256 mismatch");
    }
  }
  return body;
}
