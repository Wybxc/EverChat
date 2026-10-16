/** Abort the caller promptly even when a dynamic import cannot itself be cancelled. */
export async function abortable<T>(load: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let reject!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const cancel = () => reject(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([load(), aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
