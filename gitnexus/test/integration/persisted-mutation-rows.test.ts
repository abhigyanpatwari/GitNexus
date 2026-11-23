import { afterEach, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { persistedMutationRows } from '../../src/core/incremental/persisted-mutation-rows.js';

afterEach(() => vi.restoreAllMocks());

withTestLbugDB('persisted-mutation-rows', () => {
  it('counts old nodes plus incoming/outgoing edges, binds paths, and caps work across batches', async () => {
    const changed = "src/we'ird.ts";
    for (const [id, filePath] of [
      ['a', changed],
      ['b', 'other.ts'],
      ['c', 'unrelated.ts'],
    ]) {
      await adapter.executePrepared('CREATE (:Function {id: $id, filePath: $filePath})', {
        id,
        filePath,
      });
    }
    for (const [from, to] of [
      ['a', 'b'],
      ['b', 'a'],
      ['c', 'b'],
    ]) {
      await adapter.executePrepared(
        "MATCH (a:Function {id: $from}), (b:Function {id: $to}) CREATE (a)-[:CodeRelation {type: 'CALLS'}]->(b)",
        { from, to },
      );
    }
    expect(await persistedMutationRows([changed], 100)).toBe(3);
    expect(await persistedMutationRows([changed, changed], 100)).toBe(3);
    // Edges internal to the write set can be counted twice; never undercount.
    expect(await persistedMutationRows([changed, 'other.ts'], 100)).toBe(7);
    expect(await persistedMutationRows([changed], 2)).toBe(2);
    expect(await persistedMutationRows([changed], 0)).toBe(0);
    expect(await persistedMutationRows(['missing.ts'], 100)).toBe(0);
    expect(
      await persistedMutationRows(
        [...Array.from({ length: 201 }, (_, i) => `missing${i}.ts`), changed],
        100,
      ),
    ).toBe(3);
  });

  it('propagates unreadable counts instead of certifying a small write', async () => {
    vi.spyOn(adapter, 'executePrepared').mockRejectedValueOnce(new Error('count read failed'));
    await expect(persistedMutationRows(['a.ts'], 100)).rejects.toThrow('count read failed');
  });

  it.each(
    [[], [{ rowCount: -1 }], [{ rowCount: '1' }], [{ rowCount: 101 }]].map((result) => ({
      result,
    })),
  )('rejects malformed count evidence: %j', async ({ result }) => {
    vi.spyOn(adapter, 'executePrepared').mockResolvedValueOnce(result);
    await expect(persistedMutationRows(['a.ts'], 100)).rejects.toThrow(
      'Could not measure persisted mutation rows',
    );
  });
});
