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
import type { RelationshipType } from 'gitnexus-shared';
import {
  detectGraphWriteCollapse,
  GRAPH_WRITE_COLLAPSE_MIN_EDGES,
} from '../../src/core/index-freshness.js';
import {
  computeExpectedStructuralRelationships,
  countStructuralRelationships,
  selectPersistedCollapseStamp,
} from '../../src/core/run-analyze.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

/**
 * An in-memory graph holding exactly this many relationships of each type.
 *
 * `computeExpectedStructuralRelationships` takes the GRAPH rather than a
 * pre-selected number, so the heap-side term can only be exercised through
 * something that iterates like one. Only `forEachRelationshipFields` is used —
 * the same zero-allocation columnar scan production walks.
 */
const graphWith = (
  byType: Partial<Record<RelationshipType, number>>,
): Pick<KnowledgeGraph, 'forEachRelationshipFields'> => ({
  forEachRelationshipFields(fn) {
    for (const [type, count] of Object.entries(byType)) {
      for (let i = 0; i < (count ?? 0); i++) fn('src', 'dst', type as RelationshipType, 1);
    }
  },
});

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
    expect(detectGraphWriteCollapse(bare, 4000)).toEqual({ verdict: 'healthy' });
    expect(detectGraphWriteCollapse(expectedRelationships(bare, streamed), 4000)).toEqual({
      verdict: 'collapsed',
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
    expect(detectGraphWriteCollapse(10000, undefined)).toEqual({
      verdict: 'unmeasurable',
      reason: 'persisted-unreadable',
    });
  });

  it('still reports a genuine zero that WAS measured', () => {
    expect(detectGraphWriteCollapse(10000, 0)).toEqual({
      verdict: 'collapsed',
      expected: 10000,
      persisted: 0,
    });
  });
});

describe('graph-collapse wiring: total loss is never exempt (3c)', () => {
  it('reports a small repo that lost every edge', () => {
    const small = GRAPH_WRITE_COLLAPSE_MIN_EDGES - 1;
    expect(detectGraphWriteCollapse(small, 0)).toEqual({
      verdict: 'collapsed',
      expected: small,
      persisted: 0,
    });
  });

  it('keeps exempting a small repo that lost only some', () => {
    const small = GRAPH_WRITE_COLLAPSE_MIN_EDGES - 1;
    expect(detectGraphWriteCollapse(small, small - 1)).toEqual({ verdict: 'healthy' });
  });
});

describe('graph-collapse wiring: incremental writes are not comparable (3a)', () => {
  // An incremental run persists only the changed subgraph while both counts are
  // whole-scope. A 10,000-edge index whose incremental rewrite lost 200
  // replacements reads 9,800 of 10,000 — above the ratio — so a corrupt index
  // would be certified complete. `run-analyze` therefore skips the check
  // entirely on that path; this pins the arithmetic that makes skipping right.
  it('cannot see a real incremental loss through whole-scope counts', () => {
    expect(detectGraphWriteCollapse(10000, 9800)).toEqual({ verdict: 'healthy' });
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
  /** The measured `--force` shape: 20,825 in the heap, all of it structural
   *  because the PDG layers went to the sink. */
  const forcedRunHeap = graphWith({ CALLS: 20_825 });

  it('uses the sink STRUCTURAL subtotal, not its total-row size hint', () => {
    // 179,676 streamed of which 69,771 were structural.
    expect(
      computeExpectedStructuralRelationships(forcedRunHeap, {
        structuralRows: 69_771,
        totalRows: 179_676,
      }),
    ).toBe(90_596);
  });

  it('does not report a collapse on a healthy --pdg run', () => {
    const expected = computeExpectedStructuralRelationships(forcedRunHeap, {
      structuralRows: 69_771,
      totalRows: 179_676,
    });
    // The structural rows actually readable back. Well above the ratio.
    expect(detectGraphWriteCollapse(expected, 64_764)).toEqual({ verdict: 'healthy' });
  });

  it('would have reported one against the unfiltered total — the bug', () => {
    // Pinning the defect itself: feeding the total-row hint reproduces the
    // false INCOMPLETE exactly, so the distinction cannot be quietly undone.
    expect(detectGraphWriteCollapse(20_825 + 179_676, 64_764)).toEqual({
      verdict: 'collapsed',
      expected: 200_501,
      persisted: 64_764,
    });
  });

  it('still detects a REAL structural collapse', () => {
    // The subtraction must not blind the check.
    const expected = computeExpectedStructuralRelationships(forcedRunHeap, {
      structuralRows: 69_771,
      totalRows: 179_676,
    });
    expect(detectGraphWriteCollapse(expected, 1_000)).toEqual({
      verdict: 'collapsed',
      expected: 90_596,
      persisted: 1_000,
    });
  });

  it('picks structuralRows over totalRows when they differ', () => {
    // The field choice itself, which a numeric parameter left at an untestable
    // call site — and choosing wrong there is the whole defect.
    expect(
      computeExpectedStructuralRelationships(graphWith({}), { structuralRows: 7, totalRows: 999 }),
    ).toBe(7);
  });
});

/**
 * THE NON-`--force` HALF OF THE SAME DEFECT.
 *
 * Excluding PDG from the STREAMED term fixed the `--force` configuration only.
 * Streaming needs `force === true` on both sides — `resolveStreamGraphEmit`
 * opens with `if (options.force !== true) return false`, `resolveStreamPdgEmit`
 * requires it too — so a plain `gitnexus analyze --pdg` has NO sink, there is no
 * manifest to subtract from, and `scope-resolution/pipeline/run.ts` writes the
 * PDG layers straight into the ordinary graph (`input.pdgEmitSink ?? graph`).
 * Verified by running `runScopeResolution({ pdg: true })` with no sink: the
 * resulting `relationshipCount` is 1 and every row of it is `CFG`.
 *
 * A FIRST analyze has no `existingMeta`, so it is not incremental, so the
 * collapse check runs on it — against structural-plus-PDG expected and
 * structural-only persisted. The heap term is therefore counted the same
 * type-aware way the sink counts its own subtotal, which makes both sides
 * measure one population in EVERY configuration rather than only under
 * `--force`.
 */
describe('graph-collapse wiring: PDG resident in the heap is excluded too (no --force)', () => {
  it('counts only structural rows out of a PDG-inclusive in-memory graph', () => {
    // The non-streaming shape: everything is in the heap, PDG included.
    expect(countStructuralRelationships(graphWith({ CALLS: 60_000, CFG: 110_000 }))).toBe(60_000);
  });

  it('excludes every PDG edge type, not just CFG', () => {
    expect(
      countStructuralRelationships(
        graphWith({
          CFG: 1,
          REACHING_DEF: 2,
          CDG: 3,
          POST_DOMINATE: 4,
          TAINTED: 5,
          SANITIZES: 6,
          CALLS: 7,
        }),
      ),
    ).toBe(7);
  });

  it('keeps counting TAINT_PATH, which is structural despite being a --pdg product', () => {
    // Deliberately NOT in PDG_EDGE_TYPES: a whole-program Function→Function edge
    // that lives in the in-memory graph and is persisted by the normal emit, so
    // it is counted on BOTH sides. Dropping it here would understate `expected`.
    expect(countStructuralRelationships(graphWith({ TAINT_PATH: 3, CFG: 9 }))).toBe(3);
  });

  it('does not treat a PDG-inclusive heap count as a structural expectation', () => {
    // The regression itself. 60,000 structural + 110,000 PDG resident, with no
    // manifest because nothing streamed; 58,000 structural rows read back is a
    // healthy write. Taking `relationshipCount` (170,000) makes 58,000 look like
    // a 66% loss and fails a complete index on its very first `--pdg` run.
    const expected = computeExpectedStructuralRelationships(
      graphWith({ CALLS: 60_000, CFG: 110_000 }),
      undefined,
    );
    expect(expected).toBe(60_000);
    expect(detectGraphWriteCollapse(expected, 58_000)).toEqual({ verdict: 'healthy' });
    // What the PDG-inclusive count would have produced, pinned so the term
    // cannot be quietly restored.
    expect(detectGraphWriteCollapse(170_000, 58_000)).toEqual({
      verdict: 'collapsed',
      expected: 170_000,
      persisted: 58_000,
    });
  });

  it('still detects a real collapse on a non-streaming --pdg run', () => {
    // Excluding resident PDG must not blind the check: the PDG rows persisted
    // fine and every structural edge is gone.
    const expected = computeExpectedStructuralRelationships(
      graphWith({ CALLS: 60_000, CFG: 110_000 }),
      undefined,
    );
    expect(detectGraphWriteCollapse(expected, 100)).toEqual({
      verdict: 'collapsed',
      expected: 60_000,
      persisted: 100,
    });
  });

  it('is unchanged on a run with no streaming and no PDG at all', () => {
    // The plain incremental/default run: no manifest, no PDG rows, so the
    // structural count is simply the whole graph — as it always was.
    expect(computeExpectedStructuralRelationships(graphWith({ CALLS: 10_000 }), undefined)).toBe(
      10_000,
    );
  });

  it('reaches a NO-VERDICT, not a crash, on a graph it cannot scan', () => {
    // Reading `relationshipCount` off a lightweight pipeline result yielded
    // `undefined` and therefore a non-finite `expected`, which
    // `detectGraphWriteCollapse` already documents as an expected input ("a
    // graph implementation that reports no total, a lightweight pipeline
    // result"). Scanning must degrade to the same no-verdict rather than
    // throwing an analyze that was otherwise about to succeed.
    const unscannable = {} as Partial<Pick<KnowledgeGraph, 'forEachRelationshipFields'>>;
    expect(countStructuralRelationships(unscannable)).toBeNaN();
    expect(countStructuralRelationships(undefined)).toBeNaN();
    const expected = computeExpectedStructuralRelationships(unscannable, undefined);
    expect(expected).toBeNaN();
    expect(detectGraphWriteCollapse(expected, 5_000)).toEqual({
      verdict: 'unmeasurable',
      reason: 'expected-unavailable',
    });
  });
});

/**
 * THE STAMP TAXONOMY, which was documented three-way and implemented two-way.
 *
 * `selectPersistedCollapseStamp` decides what `saveMeta` writes, and `saveMeta`
 * OVERWRITES rather than merges — so returning `undefined` deletes the stamp,
 * and the stamp is what marks the index incomplete and forces the repairing
 * rebuild. The shipped code split on `wroteChangedSubgraphOnly` (the write MODE)
 * instead of on whether a verdict was reached, so a FULL run that could not
 * measure took the "no collapse ⇒ clear it" branch.
 */
describe('graph-collapse wiring: the persisted stamp splits on the VERDICT', () => {
  const previous = { expected: 23_009, persisted: 2_170 };

  it('stamps a detected collapse', () => {
    expect(
      selectPersistedCollapseStamp(
        { verdict: 'collapsed', expected: 10_000, persisted: 100 },
        undefined,
      ),
    ).toEqual({ expected: 10_000, persisted: 100 });
  });

  it('overwrites an older stamp with the collapse this run measured', () => {
    expect(
      selectPersistedCollapseStamp(
        { verdict: 'collapsed', expected: 10_000, persisted: 100 },
        previous,
      ),
    ).toEqual({ expected: 10_000, persisted: 100 });
  });

  it('CLEARS the stamp on a measured healthy full run', () => {
    expect(selectPersistedCollapseStamp({ verdict: 'healthy' }, previous)).toBeUndefined();
  });

  it('CARRIES the stamp forward when the structural count could not be read', () => {
    // The reported trigger: run 1 genuinely collapses and is stamped; run 2 is
    // forced full by that stamp, but its `WHERE NOT r.type IN [...]` query
    // throws on `withConnLock` contention with the WAL-checkpoint driver. The
    // old code read that as "full run, no collapse" and deleted the stamp, so
    // run 3 took `alreadyUpToDate`, printed "Already up to date" and exited 0 —
    // forever, on an index still missing 91% of its edges.
    expect(
      selectPersistedCollapseStamp(
        { verdict: 'unmeasurable', reason: 'persisted-unreadable' },
        previous,
      ),
    ).toEqual(previous);
  });

  it('carries it forward on an incremental write and on an unavailable expectation', () => {
    expect(
      selectPersistedCollapseStamp(
        { verdict: 'unmeasurable', reason: 'incremental-write' },
        previous,
      ),
    ).toEqual(previous);
    expect(
      selectPersistedCollapseStamp(
        { verdict: 'unmeasurable', reason: 'expected-unavailable' },
        previous,
      ),
    ).toEqual(previous);
  });

  it('invents nothing when there was no previous stamp', () => {
    expect(
      selectPersistedCollapseStamp(
        { verdict: 'unmeasurable', reason: 'persisted-unreadable' },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('routes an unreadable persisted count to unmeasurable, not to a clear', () => {
    // End to end through the predicate: this is the pairing that erased stamps.
    const verdict = detectGraphWriteCollapse(10_000, undefined);
    expect(verdict).toEqual({ verdict: 'unmeasurable', reason: 'persisted-unreadable' });
    expect(selectPersistedCollapseStamp(verdict, previous)).toEqual(previous);
  });
});
