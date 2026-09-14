/**
 * mxRaven webhook signature verification.
 */

import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { readBoundedBody } from "./body.js";
import { decode } from "./decode.js";
import { InvalidSignatureError } from "./errors.js";
import type { Event } from "./payload.js";

/**
 * The mxRaven signature headers.
 *
 * HTTP header names are case-insensitive; these constants carry the canonical
 * spelling used by mxRaven.
 */
export const webhookHeaders = {
  /** The delivery ID, which is the delivery task ID. */
  webhookId: "X-MxRaven-Webhook-ID",
  /** The Unix signing time in seconds. */
  timestamp: "X-MxRaven-Timestamp",
  /** The `sha256=<hex>` HMAC. */
  signature: "X-MxRaven-Signature",
  /** The signing key ID. */
  signatureKid: "X-MxRaven-Signature-Kid",
} as const;

/** Options for a {@link Verifier}. */
export interface VerifierOptions {
  /** The signing secret, used as literal bytes and not decoded. */
  readonly secret?: string;
  /** Per-key secrets for key rotation, keyed by signing key ID. */
  readonly keys?: ReadonlyMap<string, string>;
  /** The maximum accepted clock skew in milliseconds. Defaults to 5 minutes; `0` disables the check. */
  readonly tolerance?: number;
  /** The maximum request body size in bytes. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number;
}

/** Per-call options for verification. */
export interface VerifyOptions {
  /** Cancels the body read. */
  readonly signal?: AbortSignal;
}

const DEFAULT_TOLERANCE = 5 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 1 << 20;

/**
 * Verifies the signature of an mxRaven webhook request.
 *
 * A verifier is safe for concurrent use once constructed. Configure it with a
 * signing secret or with per-key secrets for rotation.
 *
 * @example
 * ```ts
 * const secret = process.env.MXRAVEN_WEBHOOK_SECRET;
 * if (secret === undefined || secret === "") {
 *   throw new Error("MXRAVEN_WEBHOOK_SECRET is required");
 * }
 *
 * const verifier = new Verifier({ secret });
 * const event = await verifier.verifyAndDecode(request);
 * ```
 *
 * @public
 */
export class Verifier {
  private readonly secret: string | undefined;
  private readonly keys: ReadonlyMap<string, string>;
  private readonly tolerance: number;
  private readonly maxBodyBytes: number;

  /**
   * @param options - The signing secret and verification limits.
   * @throws `Error` When no secret is provided or an option is invalid.
   */
  constructor(options: VerifierOptions = {}) {
    const keys = new Map<string, string>();
    for (const [kid, secret] of options.keys ?? []) {
      if (kid.trim() === "") {
        throw new Error("webhook: signing key ID must not be empty");
      }
      if (secret === "") {
        throw new Error("webhook: signing secret must not be empty");
      }
      keys.set(kid, secret);
    }

    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    if (tolerance < 0) {
      throw new Error("webhook: tolerance must not be negative");
    }
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      throw new Error("webhook: maximum body size must be positive");
    }

    const secret = options.secret;
    if ((secret === undefined || secret === "") && keys.size === 0) {
      throw new Error("webhook: a signing secret is required");
    }
    if (secret !== undefined && secret === "") {
      throw new Error("webhook: signing secret must not be empty");
    }

    this.secret = secret;
    this.keys = keys;
    this.tolerance = tolerance;
    this.maxBodyBytes = maxBodyBytes;
  }

  /**
   * Verifies a request's signature.
   *
   * The body is read from a clone, so the caller can still read the original
   * request body afterwards.
   *
   * @param request - The incoming request.
   * @param options - An optional cancellation signal.
   * @throws {@link InvalidSignatureError} When the signature does not match.
   * @throws `Error` When required headers are missing, the timestamp is stale,
   * or the body exceeds the configured limit.
   */
  async verify(request: Request, options: VerifyOptions = {}): Promise<void> {
    const body = await this.readBody(request, options.signal);
    this.check(request, body);
  }

  /**
   * Verifies a request and decodes its payload.
   *
   * @param request - The incoming request.
   * @param options - An optional cancellation signal.
   * @returns The decoded event.
   * @throws {@link InvalidSignatureError} When the signature does not match.
   * @throws `Error` When verification or decoding fails.
   */
  async verifyAndDecode(request: Request, options: VerifyOptions = {}): Promise<Event> {
    const body = await this.readBody(request, options.signal);
    this.check(request, body);
    return decode(body);
  }

  private async readBody(request: Request, signal?: AbortSignal): Promise<Uint8Array> {
    const clone = request.clone();
    return readBoundedBody(clone.body, this.maxBodyBytes, signal, "request body");
  }

  private check(request: Request, body: Uint8Array): void {
    const webhookId = request.headers.get(webhookHeaders.webhookId)?.trim() ?? "";
    if (webhookId === "") {
      throw new Error("webhook: missing webhook ID header");
    }
    const timestamp = request.headers.get(webhookHeaders.timestamp)?.trim() ?? "";
    if (timestamp === "") {
      throw new Error("webhook: missing timestamp header");
    }
    const signature = request.headers.get(webhookHeaders.signature)?.trim() ?? "";
    if (signature === "") {
      throw new Error("webhook: missing signature header");
    }

    if (this.tolerance > 0) {
      if (!/^\d+$/.test(timestamp)) {
        throw new Error(`webhook: invalid timestamp ${JSON.stringify(timestamp)}`);
      }
      const skew = Math.abs(Date.now() - Number.parseInt(timestamp, 10) * 1000);
      if (skew > this.tolerance) {
        throw new Error("webhook: timestamp is outside the accepted clock skew");
      }
    }

    const secret = this.secretFor(request.headers.get(webhookHeaders.signatureKid));

    const scheme = "sha256=";
    if (!signature.startsWith(scheme)) {
      throw new Error("webhook: unsupported signature algorithm");
    }
    const provided = decodeHex(signature.slice(scheme.length));
    if (provided === undefined) {
      throw new Error("webhook: malformed signature");
    }

    const expected = signRequest(secret, {
      method: request.method,
      url: new URL(request.url),
      timestamp,
      webhookId,
      body,
    });
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new InvalidSignatureError();
    }
  }

  private secretFor(kid: string | null): string {
    const value = (kid ?? "").trim();
    if (this.keys.size > 0) {
      if (value === "") {
        throw new Error("webhook: missing signature key ID");
      }
      const secret = this.keys.get(value);
      if (secret === undefined) {
        throw new Error(`webhook: unknown signature key ID ${JSON.stringify(value)}`);
      }
      return secret;
    }
    return this.secret ?? "";
  }
}

/** The inputs to the canonical signature string. */
interface SignatureInput {
  readonly method: string;
  readonly url: URL;
  readonly timestamp: string;
  readonly webhookId: string;
  readonly body: Uint8Array;
}

/** Computes the expected HMAC over the canonical request string. */
function signRequest(secret: string, input: SignatureInput): Buffer {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const canonical = [
    input.timestamp,
    input.webhookId,
    input.method,
    input.url.host.toLowerCase(),
    canonicalTarget(input.url),
    bodyHash,
  ].join("\n");
  return createHmac("sha256", secret).update(canonical).digest();
}

/** Returns the escaped path plus the raw query, or `/`. */
function canonicalTarget(url: URL): string {
  let value = url.pathname === "" ? "/" : url.pathname;
  if (url.search !== "") {
    value += url.search;
  }
  return value;
}

/** Decodes a lowercase or uppercase hex string, or returns `undefined`. */
function decodeHex(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "hex");
}
