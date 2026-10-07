/**
 * Webhook request handling and typed event dispatch.
 */

import { WebhookError } from "./errors.js";
import {
  eventType,
  type DeliveryStatus,
  type Event,
  type EventType,
  type InboundEmail,
  type StorageStatus,
} from "./payload.js";
import { Verifier, type VerifierOptions, type VerifyOptions } from "./verifier.js";

/** Handles an inbound-email delivery. */
export type InboundEmailHandler = (email: InboundEmail) => void | Promise<void>;

/** Handles an SMTP delivery-status update. */
export type DeliveryStatusHandler = (status: DeliveryStatus) => void | Promise<void>;

/** Handles an object-storage delivery-status update. */
export type StorageStatusHandler = (status: StorageStatus) => void | Promise<void>;

/**
 * The listener registered for each webhook event type.
 *
 * The keys are the wire `event_type` values, so
 * `on(eventType.inboundEmail, ...)` and `on("inbound_email", ...)` are
 * equivalent.
 */
export interface WebhookEventHandlers {
  inbound_email: InboundEmailHandler;
  delivery_status: DeliveryStatusHandler;
  s3_egress_status: StorageStatusHandler;
}

/**
 * Framework-independent request primitives.
 *
 * HTTP frameworks that do not use the Fetch API expose their request as
 * separate fields; pass them to {@link WebhookHandler.handle}. The body must be
 * the exact raw bytes of the request; a parsed JSON body cannot be verified.
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

/** Options for a {@link WebhookHandler}. */
export type WebhookHandlerOptions = VerifierOptions;

const DEFAULT_MAX_BODY_BYTES = 1 << 20;

/**
 * Verifies, decodes, and dispatches mxRaven webhook requests.
 *
 * Register one or more listeners with {@link WebhookHandler.on} and feed the
 * request to {@link WebhookHandler.handle}. Fetch-native runtimes pass the
 * `Request` directly; other frameworks pass method, URL, headers, and raw body
 * separately.
 * Listeners for an event run sequentially in registration order, and the
 * request is only acknowledged after every listener resolves, so a thrown
 * error produces a `500` and mxRaven retries the delivery.
 *
 * Protocol failures are reported through the returned status and never thrown:
 * `204` accepted, `200` reserved for duplicates, `400` malformed request,
 * `401` bad signature, `413` body too large, and `500` when a listener throws.
 *
 * A handler is safe for concurrent use; listeners must be too, because a
 * handler may run for several requests at once.
 *
 * @example
 * ```ts
 * const webhook = new WebhookHandler({ secret });
 *
 * webhook.on(eventType.inboundEmail, async (email) => {
 *   await store.save(email.task_id, email);
 * });
 *
 * export default { fetch: (request: Request) => webhook.handle(request) };
 * ```
 *
 * @public
 */
export class WebhookHandler {
  private readonly verifier: Verifier;
  private readonly maxBodyBytes: number;
  private readonly handlers: { [K in EventType]: Array<WebhookEventHandlers[K]> } = {
    inbound_email: [],
    delivery_status: [],
    s3_egress_status: [],
  };

  /**
   * @param options - The signing secret, verification limits, and key rotation
   * configuration.
   * @throws `Error` When no secret is provided or an option is invalid.
   */
  constructor(options: WebhookHandlerOptions = {}) {
    this.verifier = new Verifier(options);
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  /**
   * Registers a listener for one event type.
   *
   * Listeners for the same event run in registration order. The payload type
   * is inferred from the event name.
   *
   * @param type - The event type, for example `eventType.inboundEmail`.
   * @param handler - The listener to invoke after the request is verified.
   * @returns This handler, so registrations can be chained.
   */
  on<K extends EventType>(type: K, handler: WebhookEventHandlers[K]): this {
    this.handlers[type].push(handler);
    return this;
  }

  /**
   * Verifies, decodes, and dispatches a request.
   *
   * Accepts a Fetch API `Request`, or the framework-independent
   * {@link WebhookRequestParts} for frameworks that expose method, URL,
   * headers, and body separately. The body is read from a clone, so the caller
   * can still read the original request body afterwards.
   *
   * @param request - The incoming request, or its framework-independent fields.
   * @param options - An optional cancellation signal for the body read. Ignored
   * for {@link WebhookRequestParts}, which is already in memory.
   * @returns A response with the resulting status and an empty body. This
   * method never rejects for protocol failures: `204` accepted, `400`
   * malformed, `401` bad signature, `413` body too large, or `500` when a
   * listener throws.
   */
  async handle(
    request: Request | WebhookRequestParts,
    options: VerifyOptions = {},
  ): Promise<Response> {
    if (request instanceof Request) {
      return this.process(() => this.verifier.verifyAndDecode(request, options));
    }

    if (request.body.byteLength > this.maxBodyBytes) {
      return new Response(null, { status: 413 });
    }

    let converted: Request;
    try {
      converted = partsToRequest(request);
    } catch {
      return new Response(null, { status: 400 });
    }

    return this.process(() => this.verifier.verifyAndDecode(converted));
  }

  private async process(load: () => Promise<Event>): Promise<Response> {
    try {
      const event = await load();
      await this.dispatch(event);
      return new Response(null, { status: 204 });
    } catch (error) {
      const status = error instanceof WebhookError ? error.status : 500;
      return new Response(null, { status });
    }
  }

  private async dispatch(event: Event): Promise<void> {
    switch (event.type) {
      case eventType.inboundEmail:
        for (const handler of this.handlers.inbound_email) {
          await handler(event.inboundEmail);
        }
        return;
      case eventType.deliveryStatus:
        for (const handler of this.handlers.delivery_status) {
          await handler(event.deliveryStatus);
        }
        return;
      case eventType.storageStatus:
        for (const handler of this.handlers.s3_egress_status) {
          await handler(event.storageStatus);
        }
        return;
    }
  }
}

/** Converts framework primitives into a Fetch API request. */
function partsToRequest(parts: WebhookRequestParts): Request {
  const headers = new Headers();
  if (parts.headers instanceof Headers) {
    for (const [name, value] of parts.headers) {
      headers.append(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(parts.headers)) {
      if (typeof value === "string") {
        headers.set(name, value);
      } else if (value !== undefined) {
        for (const item of value) {
          headers.append(name, item);
        }
      }
    }
  }

  const method = parts.method.trim().toUpperCase() || "POST";
  const body = method === "GET" || method === "HEAD" ? undefined : parts.body;
  return new Request(parts.url, { method, headers, body });
}
