/**
 * The mxRaven client notification consumer.
 */

import type { ConsumerMessages } from "@nats-io/jetstream";

import { NotifyConnection, type NotifyConnectionOptions } from "./connection.js";
import { decodeNotification } from "./decode.js";
import { DecodeError, NotificationError } from "./errors.js";
import type { NotificationEvent } from "./event.js";
import { NotificationIteratorImpl, type NotificationIterator } from "./iterator.js";
import {
  stopConsuming,
  type ConsumeOptions,
  type EventsOptions,
  type NotificationClientOptions,
  type NotificationHandler,
  type NotificationHandlerResult,
} from "./options.js";

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const RETRY_BASE = 1_000;
const RETRY_MAX = 30_000;

/**
 * Consumes one listener's mxRaven client notification events over NATS
 * JetStream.
 *
 * Notifications are off by default. Enable them for the listener with the
 * mxRaven administrative API first; that creates the durable consumer this
 * client reads from.
 *
 * The connection authenticates with the listener's ordinary API key and only
 * grants access to that listener's consumer, so the key prefix and secret are
 * the same values used for SMTP submission.
 *
 * A client is safe for concurrent use. A `consume` call and an `events`
 * iterator share the durable consumer with any other client using the same API
 * key: events are distributed between them, not duplicated to each.
 *
 * @example
 * ```ts
 * const client = await NotificationClient.connect({
 *   url: "wss://notifications.mxraven.com",
 *   username: "mxr_tx_ab12cd34ef56",
 *   secret: process.env.MXRAVEN_SECRET!,
 *   listener: listenerId,
 * });
 *
 * await client.consume((event) => {
 *   if (event.kind === "accepted") {
 *     console.log("accepted", event.accepted.task_id);
 *   } else {
 *     console.log("attempt", event.attempt.taskId, event.attempt.status);
 *   }
 * });
 * ```
 *
 * @public
 */
export class NotificationClient {
  private readonly connection: NotifyConnection;

  /** @param connection - The connected transport. Use {@link connect}. */
  private constructor(connection: NotifyConnection) {
    this.connection = connection;
  }

  /**
   * Connects to the notification tier and resolves the listener's durable
   * consumer.
   *
   * The initial connection and the consumer lookup fail here rather than on
   * the first event. After a successful connection the transport reconnects
   * indefinitely when the tier is unreachable, and the consumer resumes from
   * its acknowledgement floor.
   *
   * @param options - The URL, listener API key, and listener identifier.
   * @returns A connected client.
   * @throws {@link NotificationError} When an option is invalid, the server
   * rejects the API key, or the listener's consumer does not exist.
   *
   * @example
   * ```ts
   * const client = await NotificationClient.connect({
   *   url: "wss://notifications.mxraven.com",
   *   username: "mxr_tx_ab12cd34ef56",
   *   secret: process.env.MXRAVEN_SECRET!,
   *   listener: "0b0b0b0b-1111-2222-3333-444444444444",
   * });
   * ```
   *
   * @public
   */
  static async connect(options: NotificationClientOptions): Promise<NotificationClient> {
    const normalized = normalizeOptions(options);
    return new NotificationClient(await NotifyConnection.open(normalized));
  }

  /**
   * Consumes events until the signal aborts, the client closes, or the handler
   * returns {@link stopConsuming}.
   *
   * A handler that returns normally acknowledges the event. A handler that
   * throws leaves it unacknowledged, and the server redelivers it after a
   * delay that doubles with each attempt up to 30 seconds. Events are handled
   * one at a time, so a slow handler applies backpressure to the pull.
   *
   * Cancellation is a normal stop and resolves the promise; it is not an
   * error. A decode failure without an error handler rejects with
   * {@link DecodeError}. A permanently lost consumer or connection rejects
   * with {@link NotificationError}.
   *
   * @param handler - Processes one event at a time.
   * @param options - An optional cancellation signal.
   * @returns Resolves when consumption stops.
   * @throws {@link NotificationError} When consumption fails.
   *
   * @public
   */
  async consume(handler: NotificationHandler, options: ConsumeOptions = {}): Promise<void> {
    if (typeof handler !== "function") {
      throw new NotificationError("notify: handler must be a function");
    }
    if (this.connection.isClosed) {
      throw new NotificationError("notify: client is closed");
    }
    const outer = options.signal;
    if (isAborted(outer)) {
      return;
    }

    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(outer?.reason);
    const relayClose = (): void => controller.abort();
    outer?.addEventListener("abort", relayAbort, { once: true });
    this.connection.closedSignal.addEventListener("abort", relayClose, { once: true });
    if (isAborted(outer)) {
      controller.abort(outer?.reason);
    }

    let messages: ConsumerMessages | undefined;
    const stopMessages = (): void => messages?.stop();

    const context = { signal: controller.signal };
    let requestedStop = false;

    try {
      controller.signal.addEventListener("abort", stopMessages, { once: true });
      if (controller.signal.aborted) {
        stopMessages();
      }
      messages = await this.connection.messages();
      if (controller.signal.aborted) {
        messages.stop();
      }
      const stream = messages;

      for await (const message of stream) {
        if (isAborted(outer) || this.connection.isClosed) {
          requestedStop = true;
          break;
        }

        let event: NotificationEvent;
        try {
          event = decodeNotification(message.subject, message.data);
        } catch (error) {
          const decodeError =
            error instanceof DecodeError
              ? error
              : new DecodeError({ subject: message.subject, cause: error });
          try {
            message.term();
          } catch (termError) {
            this.connection.report(this.connection.wrap("notify: terminate event", termError));
          }
          if (!this.connection.hasErrorHandler) {
            throw decodeError;
          }
          this.connection.report(decodeError);
          continue;
        }

        let result: NotificationHandlerResult;
        try {
          result = await handler(event, context);
        } catch {
          try {
            message.nak(retryDelay(message.info.deliveryCount));
          } catch (nakError) {
            this.connection.report(this.connection.wrap("notify: retry event", nakError));
          }
          continue;
        }

        try {
          message.ack();
        } catch (ackError) {
          this.connection.report(this.connection.wrap("notify: acknowledge event", ackError));
        }
        if (result === stopConsuming) {
          requestedStop = true;
          break;
        }
      }

      if (!requestedStop) {
        // A consumer that is permanently lost ends the iterator without
        // throwing; its close result carries the reason.
        const closedError = await stream.closed();
        if (closedError instanceof Error) {
          throw closedError;
        }
      }
    } catch (error) {
      if (isAborted(outer) || this.connection.isClosed) {
        return;
      }
      throw this.connection.wrap("notify: consume", error);
    } finally {
      outer?.removeEventListener("abort", relayAbort);
      this.connection.closedSignal.removeEventListener("abort", relayClose);
      controller.signal.removeEventListener("abort", stopMessages);
      controller.abort();
      messages?.stop();
    }

    if (!isAborted(outer) && !this.connection.isClosed) {
      const terminal = this.connection.terminalError();
      if (terminal !== undefined) {
        throw terminal;
      }
    }
  }

  /**
   * Iterates events without automatic acknowledgement.
   *
   * The caller acknowledges each event with `ack`, `nak`, or `term` on the
   * yielded delivery. Stopping iteration leaves unacknowledged events for
   * redelivery after the consumer's acknowledgement timeout.
   *
   * @param options - An optional cancellation signal.
   * @returns An async iterator over the listener's events.
   * @throws {@link NotificationError} When used after {@link close}, or when
   * iteration fails.
   *
   * @example
   * ```ts
   * for await (const { event, ack, nak } of client.events({ signal })) {
   *   try {
   *     await process(event);
   *     ack();
   *   } catch {
   *     nak({ delay: 5_000 });
   *   }
   * }
   * ```
   *
   * @public
   */
  events(options: EventsOptions = {}): NotificationIterator {
    return new NotificationIteratorImpl(this.connection, options.signal);
  }

  /**
   * Releases the client's connection.
   *
   * Active `consume` calls and iterators stop, and events they did not
   * acknowledge are redelivered later. Close is safe to call more than once.
   *
   * @throws {@link NotificationError} When the connection cannot be closed
   * cleanly.
   *
   * @public
   */
  close(): Promise<void> {
    return this.connection.close();
  }
}

/** Validates the public options and applies defaults. */
function normalizeOptions(options: NotificationClientOptions): NotifyConnectionOptions {
  if (options === null || typeof options !== "object") {
    throw new NotificationError("notify: options are required");
  }

  const url = typeof options.url === "string" ? options.url.trim() : "";
  if (url === "") {
    throw new NotificationError("notify: URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new NotificationError(`notify: invalid URL ${JSON.stringify(url)}`, { cause });
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new NotificationError(`notify: URL ${JSON.stringify(url)} must use the ws or wss scheme`);
  }

  const username = typeof options.username === "string" ? options.username.trim() : "";
  if (username === "") {
    throw new NotificationError("notify: username is required");
  }
  const secret = typeof options.secret === "string" ? options.secret : "";
  if (secret === "") {
    throw new NotificationError("notify: secret is required");
  }

  const listener = typeof options.listener === "string" ? options.listener.trim() : "";
  if (listener === "") {
    throw new NotificationError("notify: listener ID is required");
  }
  if (!isValidToken(listener)) {
    throw new NotificationError(
      `notify: listener ID ${JSON.stringify(listener)} must not contain '.', '*', '>', '/', '\\', or whitespace`,
    );
  }

  const consumer = options.consumer === undefined ? `notify-${listener}` : options.consumer.trim();
  if (!isValidToken(consumer)) {
    throw new NotificationError(
      `notify: consumer name ${JSON.stringify(consumer)} must not contain '.', '*', '>', '/', '\\', or whitespace`,
    );
  }

  const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
  if (!Number.isFinite(connectTimeout) || connectTimeout <= 0) {
    throw new NotificationError(`notify: invalid connect timeout ${connectTimeout}`);
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new NotificationError("notify: onError must be a function");
  }

  return {
    url,
    username,
    secret,
    listener,
    consumer,
    tls: options.tls,
    connectTimeout,
    onError: options.onError,
  };
}

/** Reports whether an optional abort signal has fired. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Reports whether a value is safe as a NATS subject token and consumer name. */
function isValidToken(value: string): boolean {
  if (value === "") {
    return false;
  }
  for (const char of value) {
    if (
      char === "." ||
      char === "*" ||
      char === ">" ||
      char === "/" ||
      char === "\\" ||
      /\s/u.test(char)
    ) {
      return false;
    }
  }
  return true;
}

/** Returns the redelivery delay for a failed handler, capped at 30 seconds. */
function retryDelay(deliveryCount: number): number {
  if (!Number.isFinite(deliveryCount) || deliveryCount <= 1) {
    return RETRY_BASE;
  }
  let delay = RETRY_BASE;
  for (let attempt = 1; attempt < deliveryCount && delay < RETRY_MAX; attempt++) {
    delay *= 2;
  }
  return Math.min(delay, RETRY_MAX);
}
