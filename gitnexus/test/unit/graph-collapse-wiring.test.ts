/**
 * The NUMBERS fed to `detectGraphWriteCollapse`, which is where every defect
 * in it turned out to live (review finding 3).
 *
 * The predicate itself was probed hard and held. What did not hold was
 * everything around it: the expected count omitted streamed edges, an
 * unreadable edge count arrived as a measured zero, a total loss was exempted
 * for being small, and a detected collapse still reported success. Only the
 * pure helper had tests; nothing exercised the wiring at all.
 */
import { describe, it, expect } from 'vitest';
import {
  detectGraphWriteCollapse,
  GRAPH_WRITE_COLLAPSE_MIN_EDGES,
} from '../../src/core/index-freshness.js';

/**
 * The `expected` count as `run-analyze` computes it. Kept as a tiny local
 * mirror rather than an import because the production expression is inline in
 * a 3000-line function; what matters is that the manifest term is present and
 * that its absence is observable.
 */
const expectedRelationships = (inMemory: number, streamedRows: number | undefined): number =>
  inMemory + (streamedRows ?? 0);

describe('graph-collapse wiring: the expected count (3a)', () => {
  it('counts streamed edges that never entered the heap', () => {
    // Streaming moves the bulk types out of `relationshipCount` at parse time.
    // With 200 in memory and 9800 streamed, a DB holding 4000 is a real
    // collapse — but against the bare in-memory count it looks like a 20x
    // SURPLUS and the ratio passes trivially.
    const bare = 200;
    const streamed = 9800;
    expect(detectGraphWriteCollapse(bare, 4000)).toBeUndefined();
    expect(detectGraphWriteCollapse(expectedRelationships(bare, streamed), 4000)).toEqual({
      expected: 10000,
      persisted: 4000,
    });
  });

  it('is unchanged when streaming is inactive', () => {
    expect(expectedRelationships(10000, undefined)).toBe(10000);
  });
});

describe('graph-collapse wiring: an unreadable count is not zero (3b)', () => {
  // `getLbugStats` initialised its edge total to 0 and ran the query inside a
  // swallowing catch, so a WAL/lock throw during finalize — documented on this
  // exact call — produced a measured-looking 0 and certified a HEALTHY index as
  // a total collapse.
  it('says nothing when the edge count could not be taken', () => {
    expect(detectGraphWriteCollapse(10000, undefined)).toBeUndefined();
  });

  it('still reports a genuine zero that WAS measured', () => {
    expect(detectGraphWriteCollapse(10000, 0)).toEqual({ expected: 10000, persisted: 0 });
  });
});

describe('graph-collapse wiring: total loss is never exempt (3c)', () => {
  it('reports a small repo that lost every edge', () => {
    const small = GRAPH_WRITE_COLLAPSE_MIN_EDGES - 1;
    expect(detectGraphWriteCollapse(small, 0)).toEqual({ expected: small, persisted: 0 });
  });

  it('keeps exempting a small repo that lost only some', () => {
    const small = GRAPH_WRITE_COLLAPSE_MIN_EDGES - 1;
    expect(detectGraphWriteCollapse(small, small - 1)).toBeUndefined();
  });
});

describe('graph-collapse wiring: incremental writes are not comparable (3a)', () => {
  // An incremental run persists only the changed subgraph while both counts are
  // whole-scope. A 10,000-edge index whose incremental rewrite lost 200
  // replacements reads 9,800 of 10,000 — above the ratio — so a corrupt index
  // would be certified complete. `run-analyze` therefore skips the check
  // entirely on that path; this pins the arithmetic that makes skipping right.
  it('cannot see a real incremental loss through whole-scope counts', () => {
    expect(detectGraphWriteCollapse(10000, 9800)).toBeUndefined();
  });
});
