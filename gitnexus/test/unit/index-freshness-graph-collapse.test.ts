/**
 * B2 — a refresh that reports SUCCESS while leaving the index unusable.
 *
 * The dangerous variant of a broken refresh: metadata IS written, so the index
 * reads as fresh, hooks re-arm, and every tool answers from a graph missing
 * most of its edges — which is indistinguishable from a codebase that
 * genuinely has no such relationships. Observed as edges collapsing
 * 23009 -> 2170, and as a `CodeRelation` table that never materialized (which
 * reads back as a persisted count of zero).
 *
 * `analyze` compares the relationship count the pipeline produced against what
 * the DB hands back after the write and records `graphWriteCollapsed`. This
 * covers the translation of that record into the operator-facing reason, which
 * is what `status` and the MCP resources report.
 */
import { describe, it, expect } from 'vitest';
import {
  detectGraphWriteCollapse,
  getIndexIncompleteReasons,
  GRAPH_WRITE_COLLAPSE_MIN_EDGES,
  GRAPH_WRITE_COLLAPSE_RATIO,
  INDEX_INCOMPLETE_REASONS,
} from '../../src/core/index-freshness.js';

describe('detectGraphWriteCollapse (B2 detection)', () => {
  it('flags the reported field failure (23009 built, 2170 persisted)', () => {
    expect(detectGraphWriteCollapse(23009, 2170)).toEqual({ expected: 23009, persisted: 2170 });
  });

  it('flags a missing relation table, which reads back as zero persisted', () => {
    expect(detectGraphWriteCollapse(23009, 0)).toEqual({ expected: 23009, persisted: 0 });
  });

  it('stays silent on a healthy write', () => {
    expect(detectGraphWriteCollapse(23009, 23009)).toBeUndefined();
  });

  // A surplus is still tolerated — the detector only ever fires on a SHORTFALL,
  // and small overcounts are legitimate (a row written by a path the manifest
  // does not enumerate). What changed is the caller, not this rule.
  it('stays silent when more rows persist than expected', () => {
    expect(detectGraphWriteCollapse(1000, 4000)).toBeUndefined();
  });

  // THE CASE THIS FILE USED TO PIN THE WRONG WAY, and why the fix is at the
  // CALLER rather than here.
  //
  // The old assertion read `detectGraphWriteCollapse(1000, 4000)` with the
  // comment "PDG layers write into the same table, so persisted > expected is
  // normal". True about the table — and it quietly licensed the masking. The
  // caller passed `stats.edges`, a count of EVERY CodeRelation row, against an
  // expectation covering only the structural halves, so losing all 1,000
  // structural edges while 4,000 PDG rows persisted was indistinguishable from
  // health.
  //
  // Padding `expected` with the PDG rows does NOT fix that, which is worth
  // recording because it is the obvious move: 4,000 persisted against 5,000
  // expected still clears the 0.5 ratio. The ratio would be judging a minority
  // population. `run-analyze.ts` therefore compares STRUCTURAL against
  // STRUCTURAL, using the new `getLbugStats().structuralEdges`.
  //
  // At this level that is simply the ordinary shortfall case: once both sides
  // count structural edges only, a total structural wipeout on a --pdg run is
  // `(1000, 0)` and fires like any other.
  it('fires on a total structural loss even when PDG rows are plentiful', () => {
    expect(detectGraphWriteCollapse(1000, 0)).toEqual({ expected: 1000, persisted: 0 });
  });

  // REGRESSION. A non-numeric `expected` does not merely skip the guards, it
  // INVERTS them: `undefined < 100` is false so the small-repo exemption never
  // fires, and `0 >= undefined * 0.5` is `0 >= NaN`, also false, so the ratio
  // check "passes" too. Shipped briefly and reported healthy runs as total
  // collapses — the exact false certainty this check exists to prevent.
  it('never fires when the expected count is not a number', () => {
    expect(detectGraphWriteCollapse(undefined as unknown as number, 0)).toBeUndefined();
    expect(detectGraphWriteCollapse(NaN, 0)).toBeUndefined();
    expect(detectGraphWriteCollapse(Infinity, 0)).toBeUndefined();
  });

  it('never fires when the persisted count is not a number', () => {
    // `getLbugStats` returns `{}` under some mocks/degraded paths, so
    // `stats.edges` arrives as undefined rather than a measured zero.
    expect(detectGraphWriteCollapse(23009, undefined)).toBeUndefined();
    expect(detectGraphWriteCollapse(23009, NaN)).toBeUndefined();
  });

  it('is fail-safe when the expected count is unavailable', () => {
    // An implementation that offloads relationships out of memory may report 0;
    // a false "your index is broken" is worse than a missed one.
    expect(detectGraphWriteCollapse(0, 0)).toBeUndefined();
    expect(detectGraphWriteCollapse(0, 5000)).toBeUndefined();
  });

  it('exempts small repos where the ratio is meaningless', () => {
    // A PARTIAL shortfall under the threshold — the case the exemption was
    // written for ("a handful of edges lost to legitimate filtering").
    const justUnder = GRAPH_WRITE_COLLAPSE_MIN_EDGES - 1;
    expect(detectGraphWriteCollapse(justUnder, justUnder - 1)).toBeUndefined();
    expect(detectGraphWriteCollapse(justUnder, 1)).toBeUndefined();
  });

  // This assertion previously read `detectGraphWriteCollapse(99, 0) === undefined`,
  // pinning the defect rather than the behaviour: the exemption tested
  // `expected` before looking at `persisted` at all, so a repo that lost EVERY
  // edge was excused for being small, metadata stayed fresh and the CLI
  // reported success. Losing all of a small graph is still losing all of it.
  it('never exempts a TOTAL loss, however small the repo', () => {
    expect(detectGraphWriteCollapse(GRAPH_WRITE_COLLAPSE_MIN_EDGES - 1, 0)).toEqual({
      expected: GRAPH_WRITE_COLLAPSE_MIN_EDGES - 1,
      persisted: 0,
    });
    expect(detectGraphWriteCollapse(1, 0)).toEqual({ expected: 1, persisted: 0 });
  });

  // The boundary the total-loss rule must NOT cross: zero expected is the
  // fail-safe "cannot measure" case, not a collapse.
  it('still says nothing when nothing was expected', () => {
    expect(detectGraphWriteCollapse(0, 0)).toBeUndefined();
  });

  // An unreadable edge count is not a measured zero. `getLbugStats` now returns
  // `undefined` when the query threw, and the total-loss rule must not treat
  // that as a total loss.
  it('does not call an unreadable count a total loss', () => {
    expect(detectGraphWriteCollapse(50, undefined)).toBeUndefined();
    expect(detectGraphWriteCollapse(5000, undefined)).toBeUndefined();
  });

  it('applies exactly at the minimum-edge boundary', () => {
    expect(detectGraphWriteCollapse(GRAPH_WRITE_COLLAPSE_MIN_EDGES, 0)).toEqual({
      expected: GRAPH_WRITE_COLLAPSE_MIN_EDGES,
      persisted: 0,
    });
  });

  it('treats the ratio as inclusive — exactly at threshold is not a collapse', () => {
    const expected = 1000;
    const atThreshold = expected * GRAPH_WRITE_COLLAPSE_RATIO;
    expect(detectGraphWriteCollapse(expected, atThreshold)).toBeUndefined();
    expect(detectGraphWriteCollapse(expected, atThreshold - 1)).toBeDefined();
  });
});

describe('graph-write-collapsed incomplete reason (B2)', () => {
  it('is part of the stable reason vocabulary', () => {
    expect(INDEX_INCOMPLETE_REASONS).toContain('graph-write-collapsed');
  });

  it('reports a collapsed write as incomplete rather than fresh', () => {
    expect(
      getIndexIncompleteReasons({ graphWriteCollapsed: { expected: 23009, persisted: 2170 } }),
    ).toEqual(['graph-write-collapsed']);
  });

  it('treats a missing relation table (zero persisted) the same way', () => {
    expect(
      getIndexIncompleteReasons({ graphWriteCollapsed: { expected: 23009, persisted: 0 } }),
    ).toEqual(['graph-write-collapsed']);
  });

  it('says nothing on a healthy run', () => {
    expect(getIndexIncompleteReasons({})).toEqual([]);
    expect(getIndexIncompleteReasons(null)).toEqual([]);
  });

  it('reports alongside other reasons rather than masking them', () => {
    const reasons = getIndexIncompleteReasons({
      incrementalInProgress: { startedAt: 1, toWriteCount: 0 },
      graphWriteCollapsed: { expected: 500, persisted: 10 },
    });
    expect(reasons).toContain('incremental-in-progress');
    expect(reasons).toContain('graph-write-collapsed');
  });
});
