import lbug from '@ladybugdb/core';

/**
 * Best-effort close of one or more native `QueryResult` cursors.
 *
 * `result.getAll()` materializes rows into a JS array but does not release the
 * native cursor — leaving it open holds native resources for the connection's
 * lifetime. Both the pooled adapter (`pool-adapter.ts`) and the direct adapter
 * (`lbug-adapter.ts`) must release cursors after reading; this is the single
 * shared implementation so neither re-rolls the array-normalize + swallow loop
 * (a #2068 follow-up de-dup). Lives in its own leaf module so the two adapters
 * depend on it rather than on each other.
 *
 * `conn.execute()` can return either a single `QueryResult` or an array
 * (multi-statement); this normalizes both. Each close is independent and
 * best-effort: a failing or absent `close()` on one cursor never throws and
 * never prevents the others from closing — a cleanup failure must not mask the
 * query result or a real error at the call site.
 */
export async function closeQueryResults(
  queryResult: lbug.QueryResult | lbug.QueryResult[],
): Promise<void> {
  const results = Array.isArray(queryResult) ? queryResult : [queryResult];
  for (const r of results) {
    try {
      await r?.close();
    } catch {
      // Best-effort cleanup only.
    }
  }
}
