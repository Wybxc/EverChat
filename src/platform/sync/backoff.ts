/** Slow down unavailable services without synchronizing every client retry. */
export const syncRetryDelay = (attempt: number) =>
  Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9) * (0.8 + Math.random() * 0.4));
