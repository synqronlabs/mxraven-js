/**
 * Bounded body reads shared by request verification and raw-email download.
 *
 * @internal
 */

/** Options for {@link readBoundedBody}. */
export interface ReadBoundedBodyOptions {
  /** The stream to read, or `null` for an empty body. */
  readonly stream: ReadableStream<Uint8Array> | null;
  /** The maximum number of bytes to read. */
  readonly limit: number;
  /** Cancels the read. */
  readonly signal: AbortSignal | undefined;
  /** A label used in error messages. */
  readonly label: string;
  /** Builds the error thrown when the body exceeds the limit. */
  readonly tooLarge: (message: string) => Error;
}

/**
 * Reads a web stream, rejecting when it exceeds a byte limit.
 *
 * @param options - The stream, limit, cancellation signal, and error factory.
 * @returns The collected bytes.
 * @throws `Error` When the stream exceeds the limit or the signal aborts.
 *
 * @internal
 */
export async function readBoundedBody(options: ReadBoundedBodyOptions): Promise<Uint8Array> {
  const { stream, limit, signal, label, tooLarge } = options;
  if (stream === null) {
    return new Uint8Array();
  }
  if (signal?.aborted === true) {
    throw abortError(signal.reason);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let aborted = false;
  let abortReason: unknown = undefined;

  const onAbort = (): void => {
    aborted = true;
    abortReason = signal?.reason;
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

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
          throw tooLarge(`${label} exceeds ${limit} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (aborted) {
    throw abortError(abortReason);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Builds the error used when an aborted signal is observed. */
function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error("operation aborted", { cause: reason });
}
