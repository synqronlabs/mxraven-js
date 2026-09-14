/**
 * A bounded pool of initialized SMTP sessions.
 *
 * The pool caps the number of live connections, reuses idle ones after a NOOP
 * health check, and discards a session whose command failed so unread replies
 * cannot corrupt a later transaction.
 *
 * @internal
 */

import type { SmtpDialer } from "./dialer.js";
import { SmtpAbortError, SmtpSessionError, smtpSessionErrorKind } from "./errors.js";
import type { SmtpSession } from "./session.js";
import type { SendOptions, SmtpEnvelope, TransactionResult } from "./transaction.js";

/** Configuration for a {@link SmtpPool}. */
export interface SmtpPoolOptions {
  /** The dialer used to create new sessions. */
  readonly dialer: SmtpDialer;
  /** The maximum number of live sessions. Defaults to 5. */
  readonly size?: number;
  /** Checks a reused session with NOOP before handing it out. Defaults to true. */
  readonly healthCheck?: boolean;
}

/** A caller waiting for pool capacity. */
interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

const DEFAULT_POOL_SIZE = 5;

/** A bounded pool of SMTP sessions. */
export class SmtpPool {
  /** The maximum number of live sessions. */
  readonly size: number;

  private readonly dialer: SmtpDialer;
  private readonly healthCheck: boolean;
  private readonly idle: SmtpSession[] = [];
  private readonly owned = new Set<SmtpSession>();
  private readonly waiters: Waiter[] = [];
  private live = 0;
  private closed = false;

  constructor(options: SmtpPoolOptions) {
    this.dialer = options.dialer;
    this.size = options.size !== undefined && options.size > 0 ? options.size : DEFAULT_POOL_SIZE;
    this.healthCheck = options.healthCheck !== false;
  }

  /** Whether the pool has been closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Acquires an initialized session, waiting for capacity when necessary.
   *
   * @param signal - Cancels capacity waiting and dialing.
   * @returns A session that is checked out to the caller.
   * @throws {@link SmtpSessionError} With kind `client-closed` when the pool is
   * closed.
   */
  async acquire(signal?: AbortSignal): Promise<SmtpSession> {
    for (;;) {
      if (signal?.aborted === true) {
        throw new SmtpAbortError({ cause: signal.reason });
      }

      const idle = this.idle.pop();
      if (idle !== undefined) {
        if (!this.healthCheck) {
          return idle;
        }
        try {
          await idle.noop(signal);
          return idle;
        } catch {
          this.destroy(idle);
          continue;
        }
      }

      if (this.closed) {
        throw this.closedError();
      }
      if (this.live < this.size) {
        this.live += 1;
        try {
          const session = await this.dialer.dial(signal);
          if (this.closed) {
            this.live -= 1;
            session.close();
            this.wake();
            throw this.closedError();
          }
          this.owned.add(session);
          return session;
        } catch (error) {
          this.live -= 1;
          this.wake();
          throw error;
        }
      }

      await this.waitForSlot(signal);
    }
  }

  /**
   * Returns a session to the pool.
   *
   * A session not owned by this pool is closed and never admitted.
   *
   * @param session - The session to return.
   */
  release(session: SmtpSession): void {
    if (!this.owned.has(session)) {
      session.close();
      return;
    }
    if (this.closed) {
      this.destroy(session);
      return;
    }
    this.idle.push(session);
    this.wake();
  }

  /** Closes idle sessions and rejects callers waiting for capacity. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const session of this.idle.splice(0)) {
      this.owned.delete(session);
      this.live -= 1;
      try {
        await session.quit();
      } catch {
        session.close();
      }
    }

    for (const waiter of this.waiters.splice(0)) {
      this.detachAbort(waiter);
      waiter.reject(this.closedError());
    }
  }

  /** Sends a composed message using a pooled session. */
  async send(
    envelope: SmtpEnvelope,
    data: Uint8Array | AsyncIterable<Uint8Array>,
    options: SendOptions = {},
    signal?: AbortSignal,
  ): Promise<TransactionResult> {
    const session = await this.acquire(signal);
    try {
      const result = await session.send(envelope, data, options, signal);
      this.release(session);
      return result;
    } catch (error) {
      this.destroy(session);
      throw error;
    }
  }

  /** Sends a raw message using a pooled session. */
  async sendRaw(
    envelope: SmtpEnvelope,
    data: Uint8Array | AsyncIterable<Uint8Array>,
    options: SendOptions = {},
    signal?: AbortSignal,
  ): Promise<TransactionResult> {
    const session = await this.acquire(signal);
    try {
      const result = await session.sendRaw(envelope, data, options, signal);
      this.release(session);
      return result;
    } catch (error) {
      this.destroy(session);
      throw error;
    }
  }

  private destroy(session: SmtpSession): void {
    if (!this.owned.delete(session)) {
      session.close();
      return;
    }
    this.live -= 1;
    session.close();
    this.wake();
  }

  private waitForSlot(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(new SmtpAbortError({ cause: signal.reason }));
          return;
        }
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new SmtpAbortError({ cause: signal.reason }));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      this.detachAbort(waiter);
      waiter.resolve();
    }
  }

  private detachAbort(waiter: Waiter): void {
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
  }

  private closedError(): SmtpSessionError {
    return new SmtpSessionError(smtpSessionErrorKind.clientClosed, "smtp: pool is closed");
  }
}
