/**
 * Bounded body reads shared by the webhook verifier and raw-email download.
 *
 * @internal
 */

/**
 * Reads a web stream, rejecting when it exceeds a byte limit.
 *
 * @param stream - The stream to read, or `null` for an empty body.
 * @param limit - The maximum number of bytes to read.
 * @param signal - Cancels the read.
 * @param label - A label used in error messages.
 * @returns The collected bytes.
 * @throws `Error` When the stream exceeds the limit or the signal aborts.
 */
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Uint8Array> {
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
          throw new Error(`webhook: ${label} exceeds ${limit} bytes`);
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
  return new Error("webhook: operation aborted", { cause: reason });
}
