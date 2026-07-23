// gitnexus/src/core/move/concurrency.ts
export interface MapWithConcurrencyResult<T, R> {
  results: R[];
  failure?: { item: T; error: unknown };
}

/**
 * Run `worker` over `items` with at most `limit` in flight. With `failFast`,
 * the first rejection stops scheduling new work and is returned as `failure`
 * (already-running workers are awaited). Without it, the first rejection
 * rejects the returned promise.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: { failFast?: boolean } = {},
): Promise<MapWithConcurrencyResult<T, R>> {
  const results: R[] = new Array(items.length);
  const effectiveLimit = Math.max(1, Math.floor(limit));
  let next = 0;
  let failure: { item: T; error: unknown } | undefined;

  async function run(): Promise<void> {
    while (next < items.length && !(opts.failFast && failure)) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (error) {
        if (opts.failFast) {
          if (!failure) failure = { item: items[i], error };
          return;
        }
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.min(effectiveLimit, items.length) }, run);
  await Promise.all(workers);
  return failure ? { results, failure } : { results };
}
