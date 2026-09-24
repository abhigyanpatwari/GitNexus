import { describe, expect, it } from 'vitest';
import type { PersistedEmbeddingCount } from '../../src/core/embedding-count.js';

/**
 * ── #2790 review, finding 2: ONE counter, three call sites ─────────────
 *
 * `run-analyze.ts` (Phase 5 + the mid-run checkpoint) and `server/api.ts` both
 * publish `RepoMeta.stats.embeddings`. Their hand-copied bodies had already
 * drifted inside a single change — one ended `?? 0`, the other `?? Number.NaN`
 * — under a comment asserting they measured it "the same way". These pin the
 * shared implementation both now call, on the three inputs that told the two
 * copies apart.
 */
describe('measurePersistedEmbeddingCount (#2790 review)', () => {
  const answer = async (
    rows: Array<Record<string, unknown>> | undefined,
  ): Promise<PersistedEmbeddingCount> => {
    const { measurePersistedEmbeddingCount } = await import('../../src/core/embedding-count.js');
    return await measurePersistedEmbeddingCount(async () => rows);
  };

  it('reports a real count when the query answers with one', async () => {
    expect(await answer([{ cnt: 41 }])).toEqual({ kind: 'measured', count: 41 });
  });

  it('reports an empty table as a measured zero', async () => {
    // The distinction the whole tri-state rests on: an EMPTY table still
    // answers with one row holding 0. That is a measurement, not an absence.
    expect(await answer([{ cnt: 0 }])).toEqual({ kind: 'measured', count: 0 });
  });

  it('reports a no-row answer as unknown, not as zero', async () => {
    // `?? 0` made this a measured zero — and `Number.isFinite(0)` is true, so
    // the unknown branch became unreachable for exactly this case.
    expect(await answer([])).toMatchObject({ kind: 'unknown' });
  });

  it('reports a missing cell as unknown', async () => {
    expect(await answer([{}])).toMatchObject({ kind: 'unknown' });
  });

  it('reports a non-numeric cell as unknown', async () => {
    expect(await answer([{ cnt: 'x' }])).toMatchObject({ kind: 'unknown' });
  });

  it('reports an undefined result set as unknown', async () => {
    expect(await answer(undefined)).toMatchObject({ kind: 'unknown' });
  });

  it('reports a thrown query as unknown, carrying the reason', async () => {
    const { measurePersistedEmbeddingCount } = await import('../../src/core/embedding-count.js');
    expect(
      await measurePersistedEmbeddingCount(async () => {
        throw new Error('Binder exception: Table CodeEmbedding does not exist.');
      }),
    ).toEqual({ kind: 'unknown', reason: 'Binder exception: Table CodeEmbedding does not exist.' });
  });

  it('collapses to the optional number the callers persist', async () => {
    const { persistedEmbeddingCountOrUndefined } =
      await import('../../src/core/embedding-count.js');
    expect(persistedEmbeddingCountOrUndefined({ kind: 'measured', count: 0 })).toBe(0);
    expect(persistedEmbeddingCountOrUndefined({ kind: 'unknown', reason: 'nope' })).toBeUndefined();
  });
});
