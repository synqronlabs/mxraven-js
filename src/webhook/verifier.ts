/**
 * mxRaven request signature verification.
 *
 * Routing scripts call tenant endpoints with `mx.http`, and mxRaven signs each
 * call with the endpoint's key using the same scheme it used for webhooks. A
 * receiver verifies the request with a {@link Verifier} and then parses its own
 * payload; the script decides the body, so this module does not impose a
 * payload model.
 */

import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { readBoundedBody } from "../internal/body.js";
import { InvalidSignatureError, PayloadTooLargeError, WebhookRequestError } from "./errors.js";

/**
 * The mxRaven signature headers.
 *
 * HTTP header names are case-insensitive; these constants carry the canonical
 * spelling used by mxRaven.
 *
 * The listener and revision headers identify the script call but are not part
 * of the signed canonical request. Treat them as context, not as an
 * authorization decision.
 *
 * @public
 */
export const webhookHeaders = {
  /** The request ID, which is a fresh UUID for every call. */
  webhookId: "X-MxRaven-Webhook-ID",
  /** The Unix signing time in seconds. */
  timestamp: "X-MxRaven-Timestamp",
  /** The `sha256=<hex>` HMAC. */
  signature: "X-MxRaven-Signature",
  /** The signing key ID. */
  signatureKid: "X-MxRaven-Signature-Kid",
  /** The listener whose routing script made the call. */
  listener: "X-MxRaven-Listener",
  /** The script revision that made the call. */
  revision: "X-MxRaven-Revision",
} as const;

/** Options for a {@link Verifier}. @public */
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

/** Per-call options for verification. @public */
export interface VerifyOptions {
  /** Cancels the body read. */
  readonly signal?: AbortSignal;
}

/**
 * Framework-independent request primitives.
 *
 * HTTP frameworks that do not use the Fetch API expose their request as
 * separate fields; pass them to {@link Verifier.verify}. The body must be the
 * exact raw bytes of the request; a parsed JSON body cannot be verified.
 *
 * @public
 */
export interface WebhookRequestParts {
  /** The HTTP method, for example `POST`. */
  readonly method: string;
  /** The public, absolute request URL, including any proxy-forwarded scheme and host. */
  readonly url: string;
  /** The request headers. */
  readonly headers: Headers | Record<string, string | readonly string[] | undefined>;
  /** The exact raw request body. */
  readonly body: Uint8Array;
}

const DEFAULT_TOLERANCE = 5 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 1 << 20;

/**
 * Verifies the signature of an mxRaven request.
 *
 * This verifies signed `mx.http` calls only. An endpoint configured with a
 * stored credential is called with that credential header instead and carries
 * no `X-MxRaven-*` headers; authenticate it yourself.
 *
 * A verifier is safe for concurrent use once constructed. Configure it with a
 * signing secret or with per-key secrets for rotation.
 *
 * @example
 * ```ts
 * const secret = process.env.MXRAVEN_ENDPOINT_SECRET;
 * if (secret === undefined || secret === "") {
 *   throw new Error("MXRAVEN_ENDPOINT_SECRET is required");
 * }
 *
 * const verifier = new Verifier({ secret });
 * await verifier.verify(request);
 * const payload = await request.json();
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
   * Accepts a Fetch API `Request`, or the framework-independent
   * {@link WebhookRequestParts}. A `Request` body is read from a clone, so the
   * caller can still read the original request body afterwards. The canonical
   * host and request target come from the request URL; behind a proxy that
   * rewrites the host, pass the public URL the sender called.
   *
   * @param request - The incoming request, or its framework-independent fields.
   * @param options - An optional cancellation signal for the body read. Ignored
   * for {@link WebhookRequestParts}, which is already in memory.
   * @throws {@link InvalidSignatureError} When the signature does not match.
   * @throws {@link WebhookRequestError} When required headers are missing, the
   * timestamp is stale, the URL is invalid, or the signing key is unknown.
   * @throws {@link PayloadTooLargeError} When the body exceeds the configured
   * limit.
   */
  async verify(request: Request | WebhookRequestParts, options: VerifyOptions = {}): Promise<void> {
    if (request instanceof Request) {
      const body = await this.readBody(request, options.signal);
      this.check(request.method, new URL(request.url), request.headers, body);
      return;
    }

    if (request.body.byteLength > this.maxBodyBytes) {
      throw new PayloadTooLargeError(`webhook: request body exceeds ${this.maxBodyBytes} bytes`);
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch (cause) {
      throw new WebhookRequestError("webhook: invalid request URL", cause);
    }
    this.check(request.method, url, headersFromParts(request.headers), request.body);
  }

  private async readBody(request: Request, signal?: AbortSignal): Promise<Uint8Array> {
    const clone = request.clone();
    return readBoundedBody({
      stream: clone.body,
      limit: this.maxBodyBytes,
      signal,
      label: "webhook: request body",
      tooLarge: (message) => new PayloadTooLargeError(message),
    });
  }

  private check(method: string, url: URL, headers: Headers, body: Uint8Array): void {
    const webhookId = headers.get(webhookHeaders.webhookId)?.trim() ?? "";
    if (webhookId === "") {
      throw new WebhookRequestError("webhook: missing webhook ID header");
    }
    const timestamp = headers.get(webhookHeaders.timestamp)?.trim() ?? "";
    if (timestamp === "") {
      throw new WebhookRequestError("webhook: missing timestamp header");
    }
    const signature = headers.get(webhookHeaders.signature)?.trim() ?? "";
    if (signature === "") {
      throw new WebhookRequestError("webhook: missing signature header");
    }

    if (this.tolerance > 0) {
      if (!/^\d+$/.test(timestamp)) {
        throw new WebhookRequestError(`webhook: invalid timestamp ${JSON.stringify(timestamp)}`);
      }
      const skew = Math.abs(Date.now() - Number.parseInt(timestamp, 10) * 1000);
      if (skew > this.tolerance) {
        throw new WebhookRequestError("webhook: timestamp is outside the accepted clock skew");
      }
    }

    const secret = this.secretFor(headers.get(webhookHeaders.signatureKid));

    const scheme = "sha256=";
    if (!signature.startsWith(scheme)) {
      throw new WebhookRequestError("webhook: unsupported signature algorithm");
    }
    const provided = decodeHex(signature.slice(scheme.length));
    if (provided === undefined) {
      throw new WebhookRequestError("webhook: malformed signature");
    }

    const expected = signRequest(secret, { method, url, timestamp, webhookId, body });
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new InvalidSignatureError();
    }
  }

  private secretFor(kid: string | null): string {
    const value = (kid ?? "").trim();
    if (this.keys.size > 0) {
      if (value === "") {
        throw new WebhookRequestError("webhook: missing signature key ID");
      }
      const secret = this.keys.get(value);
      if (secret === undefined) {
        throw new WebhookRequestError(`webhook: unknown signature key ID ${JSON.stringify(value)}`);
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

/** Copies framework request headers into a case-insensitive `Headers`. */
function headersFromParts(
  headers: Headers | Record<string, string | readonly string[] | undefined>,
): Headers {
  const result = new Headers();
  if (headers instanceof Headers) {
    for (const [name, value] of headers) {
      result.append(name, value);
    }
    return result;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result.set(name, value);
    } else if (value !== undefined) {
      for (const item of value) {
        result.append(name, item);
      }
    }
  }
  return result;
}

/** Decodes a lowercase or uppercase hex string, or returns `undefined`. */
function decodeHex(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "hex");
}
