/**
 * Batching for graph queries whose input is an unbounded, caller-sized array.
 *
 * Every query built from a runtime-sized list has a ceiling: the engine parses
 * the whole expression before it runs, so an `IN [...]` literal or a per-item
 * OR chain grows the query with the input. #2915 is what that looks like when
 * it goes wrong — one OR'd pair per diff hunk overflowed LadybugDB's recursive
 * evaluator copy on a worker thread, a bare SIGBUS with no error output.
 *
 * The fix everywhere is the same shape: slice the input, run one query per
 * slice, merge in JS. This module is that shape, named once, so a new call site
 * does not have to rediscover the batch size or re-roll the loop.
 */

/**
 * Rows per graph query when the input list is caller-sized.
 *
 * Measured on a 25k-node index: for the `detect_changes` hunk→symbol query,
 * 25 items cost 1025ms, 50 cost 642ms, **100 cost 476ms**, 200 cost 613ms and
 * 800 cost 650ms — round-trip overhead dominates below 100, per-query cost
 * above it. The impact path's id lookups landed on the same number
 * independently.
 */
export const LBUG_QUERY_BATCH_SIZE = 100;

/**
 * Split `items` into consecutive slices of at most `size`.
 *
 * Returns an empty array for empty input, and never returns an empty slice, so
 * `for (const batch of chunk(xs))` always has something to query.
 */
export function chunk<T>(items: readonly T[], size: number = LBUG_QUERY_BATCH_SIZE): T[][] {
  if (size < 1) throw new RangeError(`chunk size must be >= 1, got ${size}`);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Run `run` over each batch with at most `concurrency` in flight, and return
 * the results in batch order.
 *
 * `Promise.allSettled` semantics, not `Promise.all`: a graph query that fails is
 * reported through `onError` and yields `undefined` for that batch, so one bad
 * batch degrades the result (the caller raises its own `partial` flag) instead
 * of discarding the batches that succeeded alongside it.
 *
 * Concurrency is safe here because `executeParameterized` checks a connection
 * out of the per-repo pool for the duration of the query (8 connections,
 * `pool-adapter.ts`), so parallel calls never share one. The default leaves
 * headroom for other in-flight MCP tools.
 */
export async function mapBatches<T, R>(
  batches: readonly T[],
  run: (batch: T) => Promise<R>,
  options: { concurrency?: number; onError?: (error: unknown) => void } = {},
): Promise<(R | undefined)[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: (R | undefined)[] = [];
  for (const group of chunk(batches, concurrency)) {
    const settled = await Promise.allSettled(group.map((batch) => run(batch)));
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') results.push(outcome.value);
      else {
        options.onError?.(outcome.reason);
        results.push(undefined);
      }
    }
  }
  return results;
}
