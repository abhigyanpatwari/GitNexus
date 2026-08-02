/**
 * The single implementation of "how many embedding rows are actually persisted".
 *
 * Lives in its own module — beside {@link ./embedding-mode.ts} and with the same
 * no-native-imports property — because the CLI (`run-analyze.ts`) and the server
 * (`server/api.ts`) both publish `RepoMeta.stats.embeddings`, and a review of
 * #2790 found the two hand-copied bodies had already drifted inside a single
 * change: one used `?? Number.NaN`, the other `?? 0`, under a comment asserting
 * they measured the field "the same way". Two publishers of one field must not
 * be able to disagree, so there is now one function and three call sites.
 *
 * Keeping it out of `core/embeddings/` is deliberate: `run-analyze.ts` may only
 * reach embedding modules through `await import(...)` (#2370 — no embeddings
 * module loads unless a run actually needs one), and this counter runs on the
 * ordinary finalization path of every analyze.
 *
 * TRI-STATE, and the asymmetry is the whole point. `unknown` means COULD NOT
 * ASK — the query throws for reasons that have nothing to do with how many rows
 * were written (table missing, connection closed, DB busy or read-only, the
 * VECTOR-extension DML lock #2623) — and a fabricated count is never returned in
 * its place. A wrong-LOW value is the dangerous direction: `stats.embeddings` is
 * the sole input to the next run's `existingEmbeddingCount` → `deriveEmbeddingMode`
 * → `shouldLoadCache`, so a false `0` is exactly what makes a later `--force`
 * wipe live embeddings without loading the cache.
 */

import { EMBEDDING_TABLE_NAME } from 'gitnexus-shared';

/** Callback shape both callers already satisfy with their `executeQuery`. */
export type EmbeddingCountQuery = (
  cypher: string,
) => Promise<Array<Record<string, unknown>> | undefined>;

export type PersistedEmbeddingCount =
  | { readonly kind: 'measured'; readonly count: number }
  /** `reason` is operator-facing: each caller phrases its own warning around it. */
  | { readonly kind: 'unknown'; readonly reason: string };

export const EMBEDDING_COUNT_CYPHER = `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`;

/**
 * Count the persisted embedding rows, or report that the answer never arrived.
 *
 * A MISSING row or cell counts as unknown, NOT as zero: an empty table still
 * answers with one row holding `0`, so no row / no cell means the query did not
 * really answer. That distinction is what `?? Number.NaN` buys — with `?? 0`,
 * `Number.isFinite(0)` is true and the unknown branch becomes unreachable for
 * exactly the case it exists to catch.
 */
export const measurePersistedEmbeddingCount = async (
  runQuery: EmbeddingCountQuery,
): Promise<PersistedEmbeddingCount> => {
  let rows: Array<Record<string, unknown>> | undefined;
  try {
    rows = await runQuery(EMBEDDING_COUNT_CYPHER);
  } catch (err) {
    return { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
  const row = rows?.[0];
  const parsed = Number(row?.cnt ?? row?.[0] ?? Number.NaN);
  if (Number.isFinite(parsed)) return { kind: 'measured', count: parsed };
  return {
    kind: 'unknown',
    reason:
      row === undefined
        ? 'the count query returned no row'
        : 'the count query returned a non-numeric result',
  };
};

/** `undefined` ≡ unknown, for the call sites that only need the optional number. */
export const persistedEmbeddingCountOrUndefined = (
  result: PersistedEmbeddingCount,
): number | undefined => (result.kind === 'measured' ? result.count : undefined);

/**
 * Fold a measurement into the `RepoMeta.stats.embeddings` a run publishes.
 *
 * The measurement was already shared; this fold was not, and it is the half
 * that decides what actually lands on disk — the CLI's finalization and the
 * server's `withMeasuredEmbeddingCount` each carried their own copy of the same
 * two lines. NEVER a fabricated `0`: `unknown` carries `priorCount` forward
 * (see this file's header for the chain a false zero arms), and `undefined` in
 * means `undefined` out, so a repo that never had a count keeps the field
 * absent rather than gaining an invented one.
 */
export const resolvePersistedEmbeddingCount = (
  measured: PersistedEmbeddingCount,
  priorCount: number | undefined,
): number | undefined => (measured.kind === 'measured' ? measured.count : priorCount);
