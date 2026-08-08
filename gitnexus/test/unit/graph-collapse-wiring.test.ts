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
import { computeExpectedStructuralRelationships } from '../../src/core/run-analyze.js';

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

/**
 * PDG ROWS MUST NOT INFLATE `expected` (#2899 regression).
 *
 * These import the REAL `computeExpectedStructuralRelationships` rather than the
 * local mirror above — and that is the whole point of them. The mirror exists
 * "because the production expression is inline in a 3000-line function", and a
 * mirror cannot catch a term the original got wrong. It did not catch this.
 *
 * Measured on a real repo: in-memory 20,825 + streamed 179,676 (of which ~110k
 * were PDG) gave `expected` 200,501 against a structural `persisted` of 64,764,
 * so a complete index reported INCOMPLETE and exited non-zero — then the stamp
 * forced a rebuild that did it again.
 */
describe('graph-collapse wiring: PDG rows are excluded from `expected`', () => {
  it('uses the sink STRUCTURAL subtotal, not its total-row size hint', () => {
    // 179,676 streamed of which 69,771 were structural.
    expect(
      computeExpectedStructuralRelationships(20_825, {
        structuralRows: 69_771,
        totalRows: 179_676,
      }),
    ).toBe(90_596);
  });

  it('does not report a collapse on a healthy --pdg run', () => {
    const expected = computeExpectedStructuralRelationships(20_825, {
      structuralRows: 69_771,
      totalRows: 179_676,
    });
    // The structural rows actually readable back. Well above the ratio.
    expect(detectGraphWriteCollapse(expected, 64_764)).toBeUndefined();
  });

  it('would have reported one against the unfiltered total — the bug', () => {
    // Pinning the defect itself: feeding the total-row hint reproduces the
    // false INCOMPLETE exactly, so the distinction cannot be quietly undone.
    expect(detectGraphWriteCollapse(20_825 + 179_676, 64_764)).toEqual({
      expected: 200_501,
      persisted: 64_764,
    });
  });

  it('still detects a REAL structural collapse', () => {
    // The subtraction must not blind the check.
    const expected = computeExpectedStructuralRelationships(20_825, {
      structuralRows: 69_771,
      totalRows: 179_676,
    });
    expect(detectGraphWriteCollapse(expected, 1_000)).toEqual({
      expected: 90_596,
      persisted: 1_000,
    });
  });

  it('picks structuralRows over totalRows when they differ', () => {
    // The field choice itself, which a numeric parameter left at an untestable
    // call site — and choosing wrong there is the whole defect.
    expect(computeExpectedStructuralRelationships(0, { structuralRows: 7, totalRows: 999 })).toBe(
      7,
    );
  });

  it('is unchanged on a run with no streaming at all', () => {
    expect(computeExpectedStructuralRelationships(10_000, undefined)).toBe(10_000);
  });
});
