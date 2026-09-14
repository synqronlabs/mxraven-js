/**
 * The mxRaven feedback and one-click unsubscribe client.
 */

import { Buffer } from "node:buffer";

import { FeedbackError } from "./errors.js";

/** A minimal `fetch`-compatible function. @public */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The training label for a message. */
export const disposition = {
  /** Marks the message as spam. */
  spam: "spam",
  /** Marks the message as not spam. */
  ham: "ham",
} as const;

/** The training label for a message. */
export type Disposition = (typeof disposition)[keyof typeof disposition];

/** The outcome of a successful learning request. */
export interface LearningResult {
  /** The service status, normally `learned`. */
  readonly status: string;
  /** The training label that was applied. */
  readonly disposition: Disposition;
  /** The tenant that owns the matched message. */
  readonly tenantId: string;
  /** The listener that processed the matched message. */
  readonly listenerId: string;
  /** Which stored hash matched the submitted bytes. */
  readonly matchedHashKind: string;
}

/** Options for a {@link Client}. */
export interface ClientOptions {
  /** The feedback service base URL, for example `https://feedback.mxraven.com`. */
  readonly baseUrl: string;
  /** The submission API key username. Required for learning. */
  readonly username?: string;
  /** The submission API key secret. Required for learning. */
  readonly secret?: string;
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** The request timeout in milliseconds. Defaults to 30000. */
  readonly timeout?: number;
}

/** Per-call options for feedback requests. */
export interface RequestOptions {
  /** Cancels the request. */
  readonly signal?: AbortSignal;
}

interface Credentials {
  readonly username: string;
  readonly secret: string;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_ERROR_BODY = 4096;
const MAX_RESULT_BODY = 64 * 1024;

/**
 * Calls the mxRaven feedback service.
 *
 * Learning requests authenticate with the same submission API key used for SMTP
 * submission, over HTTP Basic auth. A client is safe for concurrent use.
 *
 * @example
 * ```ts
 * const secret = process.env.MXRAVEN_SECRET;
 * if (secret === undefined || secret === "") {
 *   throw new Error("MXRAVEN_SECRET is required");
 * }
 *
 * const client = new Client({
 *   baseUrl: "https://feedback.mxraven.com",
 *   username: "mxr_tx_ab12cd34ef56",
 *   secret,
 * });
 * const result = await client.learnSpam(rawMessageBytes);
 * ```
 *
 * @public
 */
export class Client {
  private readonly baseUrl: string;
  private readonly credentials: Credentials | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeout: number;

  /**
   * @param options - The base URL, credentials, and transport options.
   * @throws `Error` When the base URL is missing or an option is invalid.
   */
  constructor(options: ClientOptions) {
    const baseUrl = options.baseUrl.trim();
    if (baseUrl === "") {
      throw new Error("feedback: base URL is required");
    }

    const username = (options.username ?? "").trim();
    const secret = options.secret ?? "";
    if ((username === "") !== (secret === "")) {
      throw new Error("feedback: username and secret must both be provided");
    }

    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`feedback: invalid timeout ${timeout}`);
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.credentials = username === "" ? undefined : { username, secret };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeout = timeout;
  }

  /**
   * Submits one training example.
   *
   * `rawMime` must be the exact raw RFC 822 bytes that mxRaven processed; the
   * service matches them against stored evidence by SHA-256. A message with no
   * matching evidence fails with a {@link FeedbackError} whose `statusCode` is
   * 404.
   *
   * @param label - The training label to apply.
   * @param rawMime - The exact raw message bytes.
   * @param options - An optional cancellation signal.
   * @returns The service's learning result.
   * @throws {@link FeedbackError} When the service returns a non-success status.
   *
   * @public
   */
  async learn(
    label: Disposition,
    rawMime: Uint8Array,
    options: RequestOptions = {},
  ): Promise<LearningResult> {
    if (label !== disposition.spam && label !== disposition.ham) {
      throw new Error(`feedback: invalid disposition ${JSON.stringify(label)}`);
    }
    const credentials = this.credentials;
    if (credentials === undefined) {
      throw new Error("feedback: credentials are required for learning");
    }

    const endpoint = `${this.baseUrl}/v1/feedback/learn/${label}`;
    const response = await this.perform(
      endpoint,
      {
        "Content-Type": "message/rfc822",
        Authorization: `Basic ${encodeBasicAuth(credentials)}`,
      },
      rawMime,
      "submit learning request",
      options,
    );
    if (!response.ok) {
      throw await this.toError(response);
    }

    const body = await readBounded(response, MAX_RESULT_BODY, "learning response");
    return parseLearningResult(body);
  }

  /** Teaches the spam filter that `rawMime` is spam. */
  learnSpam(rawMime: Uint8Array, options: RequestOptions = {}): Promise<LearningResult> {
    return this.learn(disposition.spam, rawMime, options);
  }

  /** Teaches the spam filter that `rawMime` is not spam. */
  learnHam(rawMime: Uint8Array, options: RequestOptions = {}): Promise<LearningResult> {
    return this.learn(disposition.ham, rawMime, options);
  }

  /**
   * Performs an RFC 8058 one-click unsubscribe for a token.
   *
   * This is the operation a recipient mail client performs against the
   * `List-Unsubscribe` URL; applications rarely call it directly. It is
   * unauthenticated.
   *
   * @param token - The signed unsubscribe token.
   * @param options - An optional cancellation signal.
   * @throws {@link FeedbackError} When the service returns a non-success status.
   *
   * @public
   */
  async unsubscribe(token: string, options: RequestOptions = {}): Promise<void> {
    const value = token.trim();
    if (value === "") {
      throw new Error("feedback: unsubscribe token is empty");
    }

    const endpoint = `${this.baseUrl}/v1/feedback/unsubscribe/${encodeURIComponent(value)}`;
    const response = await this.perform(
      endpoint,
      { "Content-Type": "application/x-www-form-urlencoded" },
      "List-Unsubscribe=One-Click",
      "submit unsubscribe request",
      options,
    );
    if (!response.ok) {
      throw await this.toError(response);
    }
  }

  private async perform(
    endpoint: string,
    headers: Record<string, string>,
    body: Uint8Array | string,
    label: string,
    options: RequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("feedback: request timed out")),
      this.timeout,
    );
    timer.unref();

    const signal = options.signal;
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`feedback: ${label}`, { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async toError(response: Response): Promise<FeedbackError> {
    let detail = `${response.status} ${response.statusText}`.trim();
    try {
      const body = await readBounded(response, MAX_ERROR_BODY, "error response");
      const parsed = JSON.parse(new TextDecoder().decode(body)) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
        detail = parsed.error.trim();
      }
    } catch {
      // Keep the status text when the error body is unusable.
    }
    return new FeedbackError({ statusCode: response.status, detail });
  }
}

/** Encodes HTTP Basic credentials. */
function encodeBasicAuth(credentials: Credentials): string {
  return Buffer.from(`${credentials.username}:${credentials.secret}`, "utf8").toString("base64");
}

/** Parses a learning response into its public shape. */
function parseLearningResult(body: Uint8Array): LearningResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new Error("feedback: decode learning response", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("feedback: decode learning response");
  }

  const wire = parsed as Record<string, unknown>;
  return {
    status: typeof wire.status === "string" ? wire.status : "",
    disposition: wire.disposition === disposition.ham ? disposition.ham : disposition.spam,
    tenantId: typeof wire.tenant_id === "string" ? wire.tenant_id : "",
    listenerId: typeof wire.listener_id === "string" ? wire.listener_id : "",
    matchedHashKind: typeof wire.matched_hash_kind === "string" ? wire.matched_hash_kind : "",
  };
}

/** Reads a response body, rejecting when it exceeds a byte limit. */
async function readBounded(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) {
    return new Uint8Array();
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > limit) {
          void reader.cancel().catch(() => undefined);
          throw new Error(`feedback: ${label} exceeds ${limit} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
