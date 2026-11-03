/**
 * Starts queued tasks at least `gapMs` apart, one after another.
 *
 * Notion allows about 3 requests per second per connection, so 334 ms keeps writes under it without a token bucket.
 */
export function throttle(gapMs: number) {
  let next = 0;
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const wait = next - Date.now();
    next = Math.max(next, Date.now()) + gapMs;
    if (wait > 0) await scheduler.wait(wait);
    return task();
  };
}
