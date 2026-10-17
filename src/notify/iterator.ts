/**
 * Manual iteration over client notification events.
 *
 * @internal
 */

import type { ConsumerMessages, JsMsg } from "@nats-io/jetstream";

import { NotifyConnection } from "./connection.js";
import { decodeNotification } from "./decode.js";
import { DecodeError, NotificationError } from "./errors.js";
import type { NotificationEvent } from "./event.js";

/** Options for negatively acknowledging an event. @public */
export interface NakOptions {
  /**
   * The redelivery delay in milliseconds. When omitted or zero, the server
   * redelivers the event immediately.
   */
  readonly delay?: number;
}

/** Options for terminating an event. @public */
export interface TermOptions {
  /** A reason recorded by the server when it supports one. */
  readonly reason?: string;
}

/**
 * One event yielded by a {@link NotificationIterator}.
 *
 * Exactly one of `ack`, `nak`, or `term` must be called for the event. Calling
 * more than one throws a {@link NotificationError}. An event that is never
 * settled is redelivered after the consumer's acknowledgement timeout.
 *
 * @public
 */
export interface NotificationDelivery {
  /** The decoded notification. */
  readonly event: NotificationEvent;
  /**
   * Acknowledges the event. It is not redelivered.
   *
   * @throws {@link NotificationError} When the event was already settled.
   */
  ack(): void;
  /**
   * Negatively acknowledges the event so the server redelivers it.
   *
   * @param options - An optional redelivery delay in milliseconds.
   * @throws {@link NotificationError} When the event was already settled.
   */
  nak(options?: NakOptions): void;
  /**
   * Tells the server never to redeliver the event.
   *
   * @param options - An optional reason recorded by the server.
   * @throws {@link NotificationError} When the event was already settled.
   */
  term(options?: TermOptions): void;
}

/**
 * An async iterator over a listener's notification events.
 *
 * The caller decides whether each event is acknowledged, negatively
 * acknowledged, or terminated. Use `for await` and `break` when finished; the
 * iterator stops pulling and leaves unacknowledged events for redelivery.
 * Iteration also stops when the caller aborts the signal, the client closes,
 * or the consumer is permanently lost.
 *
 * An iterator must not be iterated concurrently. Use {@link close} for explicit
 * cleanup.
 *
 * @public
 */
export interface NotificationIterator extends AsyncIterableIterator<NotificationDelivery> {
  /**
   * Stops iterating. Events that were not acknowledged are redelivered later.
   * It is safe to call more than once.
   */
  close(): Promise<void>;
}

/**
 * The concrete async iterator returned by {@link NotificationClient.events}.
 *
 * @internal
 */
export class NotificationIteratorImpl implements NotificationIterator {
  private readonly connection: NotifyConnection;
  private readonly signal: AbortSignal | undefined;
  private readonly startedClosed: boolean;
  private messages: ConsumerMessages | undefined;
  private iterator: AsyncIterator<JsMsg> | undefined;
  private abortListener: (() => void) | undefined;
  private closed = false;
  private done = false;
  private reading = false;

  constructor(connection: NotifyConnection, signal: AbortSignal | undefined) {
    this.connection = connection;
    this.signal = signal;
    this.startedClosed = connection.isClosed;
  }

  /** Yields the next event, or reports that iteration stopped. */
  async next(): Promise<IteratorResult<NotificationDelivery>> {
    if (this.startedClosed) {
      throw new NotificationError("notify: client is closed");
    }
    if (this.closed || this.done || this.connection.isClosed) {
      return stopped();
    }
    if (isAborted(this.signal)) {
      await this.close();
      return stopped();
    }
    if (this.reading) {
      throw new NotificationError("notify: iterator is already reading");
    }

    this.reading = true;
    try {
      const iterator = await this.open();
      for (;;) {
        const result = await iterator.next();
        if (result.done === true) {
          this.done = true;
          if (this.closed || isAborted(this.signal) || this.connection.isClosed) {
            return stopped();
          }
          const closedError = await this.messages?.closed();
          if (closedError instanceof Error) {
            throw this.connection.wrap("notify: iterate events", closedError);
          }
          const terminal = this.connection.terminalError();
          if (terminal !== undefined) {
            throw terminal;
          }
          return stopped();
        }

        const message = result.value;
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
          if (this.connection.hasErrorHandler) {
            this.connection.report(decodeError);
            continue;
          }
          this.done = true;
          this.shutdown();
          throw decodeError;
        }

        return {
          done: false,
          value: new DeliveryImpl(this.connection, message, event),
        };
      }
    } catch (error) {
      if (this.closed || this.connection.isClosed || isAborted(this.signal)) {
        return stopped();
      }
      throw this.connection.wrap("notify: iterate events", error);
    } finally {
      this.reading = false;
    }
  }

  /** Stops iterating. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.shutdown();
    // `ConsumerMessages.closed()` resolves only when its iterator observes the
    // stop, which may not happen while the caller is between events. `stop()`
    // already unsubscribes the pull inbox and clears its timers, so waiting for
    // the iterator to acknowledge the stop is unnecessary and can hang.
  }

  /** Implements the iterator cleanup run by `for await` when the body exits. */
  async return(): Promise<IteratorResult<NotificationDelivery>> {
    await this.close();
    return stopped();
  }

  /** Returns this iterator. */
  [Symbol.asyncIterator](): AsyncIterableIterator<NotificationDelivery> {
    return this;
  }

  /** Opens the pull consumer on first use. */
  private async open(): Promise<AsyncIterator<JsMsg>> {
    if (this.iterator !== undefined) {
      return this.iterator;
    }

    const messages = await this.connection.messages();
    if (this.closed) {
      messages.stop();
      throw new NotificationError("notify: iterator is closed");
    }
    this.messages = messages;
    this.iterator = messages[Symbol.asyncIterator]();

    if (this.signal !== undefined) {
      const onAbort = (): void => {
        messages.stop();
      };
      this.abortListener = onAbort;
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) {
        messages.stop();
      }
    }
    return this.iterator;
  }

  /** Stops the pull without waiting for its close. */
  private shutdown(): void {
    if (this.abortListener !== undefined) {
      this.signal?.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
    this.messages?.stop();
  }
}

/** One message and its acknowledgement operations. */
class DeliveryImpl implements NotificationDelivery {
  readonly event: NotificationEvent;
  private readonly connection: NotifyConnection;
  private readonly message: JsMsg;
  private settled = false;

  constructor(connection: NotifyConnection, message: JsMsg, event: NotificationEvent) {
    this.connection = connection;
    this.message = message;
    this.event = event;
  }

  ack(): void {
    this.settle();
    try {
      this.message.ack();
    } catch (error) {
      throw this.connection.wrap("notify: acknowledge event", error);
    }
  }

  nak(options: NakOptions = {}): void {
    const delay = options.delay;
    if (delay !== undefined && (!Number.isFinite(delay) || delay < 0)) {
      throw new NotificationError(`notify: invalid nak delay ${delay}`);
    }
    this.settle();
    try {
      this.message.nak(delay === 0 ? undefined : delay);
    } catch (error) {
      throw this.connection.wrap("notify: negate event", error);
    }
  }

  term(options: TermOptions = {}): void {
    this.settle();
    try {
      this.message.term(options.reason ?? "");
    } catch (error) {
      throw this.connection.wrap("notify: terminate event", error);
    }
  }

  private settle(): void {
    if (this.settled) {
      throw new NotificationError("notify: event is already settled");
    }
    this.settled = true;
  }
}

/** A completed iterator result. */
function stopped(): IteratorResult<NotificationDelivery> {
  return { done: true, value: undefined };
}

/** Reports whether an optional abort signal has fired. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
