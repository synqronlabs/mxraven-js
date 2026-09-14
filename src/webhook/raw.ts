/**
 * Downloads the raw message referenced by a `DELIVER_WEBHOOK` payload.
 */

import { createHash } from "node:crypto";

import { readBoundedBody } from "./body.js";
import type { RawEmail } from "./payload.js";

/** Bounds a download when the payload does not declare a size. */
const MAX_RAW_EMAIL_BYTES = 64 << 20;

/** A minimal `fetch`-compatible function. @public */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link fetchRawEmail}. */
export interface FetchRawEmailOptions {
  /** Cancels the download. */
  readonly signal?: AbortSignal;
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * Downloads the raw RFC 822 message referenced by a `DELIVER_WEBHOOK` payload.
 *
 * The payload's short-lived bearer token is sent in the `Authorization` header,
 * and the downloaded bytes are verified against the declared size and SHA-256
 * digest. Treat `raw_email.access_token` as a secret and do not log it.
 *
 * @param raw - The `raw_email` object from an inbound-email payload.
 * @param options - An optional cancellation signal and `fetch` implementation.
 * @returns The exact message bytes.
 * @throws `Error` When the URL or token is empty, the response is unsuccessful,
 * or the downloaded bytes fail the size or digest check.
 *
 * @example
 * ```ts
 * const bytes = await fetchRawEmail(event.inboundEmail.rawEmail, { signal });
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
    throw new Error("webhook: raw email URL is empty");
  }
  const token = raw.access_token.trim();
  if (token === "") {
    throw new Error("webhook: raw email access token is empty");
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const tokenType = (raw.token_type ?? "").trim();
  const scheme = tokenType === "" ? "Bearer" : tokenType;

  const response = await fetcher(url, {
    method: "GET",
    headers: { Authorization: `${scheme} ${token}` },
    signal: options.signal,
  });
  if (!response.ok) {
    const statusText = response.statusText === "" ? "" : ` ${response.statusText}`;
    throw new Error(`webhook: fetch raw email: unexpected status ${response.status}${statusText}`);
  }

  const size = raw.size_bytes ?? 0;
  const limit = size > 0 ? size + 1 : MAX_RAW_EMAIL_BYTES;
  const body = await readBoundedBody(response.body, limit, options.signal, "raw email");

  if (size > 0 && body.byteLength !== size) {
    throw new Error(`webhook: raw email size = ${body.byteLength} bytes, want ${size}`);
  }

  const digest = (raw.sha256_hex ?? "").trim();
  if (digest !== "") {
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual.toLowerCase() !== digest.toLowerCase()) {
      throw new Error("webhook: raw email SHA-256 mismatch");
    }
  }
  return body;
}
