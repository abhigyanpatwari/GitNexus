/**
 * `rMergeBindings` orders the bindings of one tier by node id. The order must be the same on every
 * machine, so it compares code units, not `localeCompare`, which follows the locale: in an
 * English collation `a` sorts before `B` and `é` before `f`; by code unit `B` and `f` come first.
 */
import { describe, expect, it } from 'vitest';
import type { BindingRef, ImportEdge, Range, SymbolDefinition } from 'gitnexus-shared';
import { rMergeBindings } from '../../../../src/core/ingestion/languages/r/simple-hooks.js';

const local = (nodeId: string): BindingRef => ({
  origin: 'local',
  def: { nodeId } as SymbolDefinition,
});

const order = (...ids: string[]): string[] =>
  rMergeBindings(ids.map(local), [], 'scope:test').map((b) => b.def.nodeId);

describe('rMergeBindings', () => {
  it('orders same-tier bindings by code unit', () => {
    expect(order('Function:a.R:a', 'Function:a.R:B')).toEqual(['Function:a.R:B', 'Function:a.R:a']);
    expect(order('Function:a.R:é', 'Function:a.R:f')).toEqual(['Function:a.R:f', 'Function:a.R:é']);
  });

  it('gives the same order whichever way round the bindings arrive', () => {
    expect(order('Function:a.R:B', 'Function:a.R:a')).toEqual(['Function:a.R:B', 'Function:a.R:a']);
  });

  it('keeps one binding per node and prefers the tightest tier', () => {
    const merged = rMergeBindings(
      [local('Function:a.R:x'), { origin: 'import', def: { nodeId: 'Function:b.R:x' } as never }],
      [local('Function:a.R:x')],
      'scope:test',
    );
    expect(merged.map((b) => b.def.nodeId)).toEqual(['Function:a.R:x']);
  });
});

describe('rMergeBindings: library() masking in the wildcard tier', () => {
  const at = (startLine: number, startCol = 0): Range => ({
    startLine,
    startCol,
    endLine: startLine,
    endCol: startCol + 12,
  });
  /** A name brought in by the `library()` call that starts at `range` (none: no position known). */
  const attached = (nodeId: string, range?: Range): BindingRef => ({
    origin: 'wildcard',
    def: { nodeId } as SymbolDefinition,
    via: { atRange: range } as ImportEdge,
  });
  const ids = (merged: BindingRef[]): string[] => merged.map((b) => b.def.nodeId);

  it('keeps only the package attached last, whichever way round the bindings arrive', () => {
    const lp = attached('Function:lp/R/f.R:dup', at(1));
    const lp2 = attached('Function:lp2/R/f.R:dup', at(2));
    expect(ids(rMergeBindings([lp], [lp2], 's'))).toEqual(['Function:lp2/R/f.R:dup']);
    expect(ids(rMergeBindings([lp2], [lp], 's'))).toEqual(['Function:lp2/R/f.R:dup']);
    expect(ids(rMergeBindings([lp, lp2], [], 's'))).toEqual(['Function:lp2/R/f.R:dup']);
  });

  it('is decided by the position of the call, not by the id order of the files', () => {
    const early = attached('Function:z/R/f.R:dup', at(1));
    const late = attached('Function:a/R/f.R:dup', at(2));
    expect(ids(rMergeBindings([early, late], [], 's'))).toEqual(['Function:a/R/f.R:dup']);
  });

  it('compares the column when two calls share a line', () => {
    const first = attached('Function:b/R/f.R:dup', at(3, 0));
    const second = attached('Function:a/R/f.R:dup', at(3, 14));
    expect(ids(rMergeBindings([first, second], [], 's'))).toEqual(['Function:a/R/f.R:dup']);
  });

  it('keeps a package named by several calls where it was first attached, however the bindings are batched', () => {
    const a1 = attached('Function:pa/R/f.R:dup', at(1));
    const b2 = attached('Function:pb/R/f.R:dup', at(2));
    const a3 = attached('Function:pa/R/f.R:dup', at(3));
    // library(pa); library(pb); library(pa): R leaves pa where it was, so pb was attached last.
    expect(ids(rMergeBindings([a1, b2], [a3], 's'))).toEqual(['Function:pb/R/f.R:dup']);
    expect(ids(rMergeBindings([a3], [a1, b2], 's'))).toEqual(['Function:pb/R/f.R:dup']);
    expect(ids(rMergeBindings([a1, b2, a3], [], 's'))).toEqual(['Function:pb/R/f.R:dup']);
    // library(pb); library(pa); library(pb): pa was attached last.
    const a2 = attached('Function:pa/R/f.R:dup', at(2));
    const b1 = attached('Function:pb/R/f.R:dup', at(1));
    const b3 = attached('Function:pb/R/f.R:dup', at(3));
    expect(ids(rMergeBindings([b1, a2], [b3], 's'))).toEqual(['Function:pa/R/f.R:dup']);
  });

  it('keeps first-attachment order when the bindings arrive one at a time, as the pipeline folds them', () => {
    /** Fold `bindings` through the merger one at a time, in the given order. */
    const fold = (...bindings: BindingRef[]): string[] => {
      let merged: BindingRef[] = [];
      for (const b of bindings) merged = rMergeBindings(merged, [b], 's');
      return ids(merged);
    };
    const pa = (line: number) => attached('Function:pa/R/f.R:dup', at(line));
    const pb = (line: number) => attached('Function:pb/R/f.R:dup', at(line));
    // A/B/A -> B, B/A/B -> A, A/B/A/B -> B, A/A/B -> B, A/B/B -> B.
    expect(fold(pa(1), pb(2), pa(3))).toEqual(['Function:pb/R/f.R:dup']);
    expect(fold(pb(1), pa(2), pb(3))).toEqual(['Function:pa/R/f.R:dup']);
    expect(fold(pa(1), pb(2), pa(3), pb(4))).toEqual(['Function:pb/R/f.R:dup']);
    expect(fold(pa(1), pa(2), pb(3))).toEqual(['Function:pb/R/f.R:dup']);
    expect(fold(pa(1), pb(2), pb(3))).toEqual(['Function:pb/R/f.R:dup']);
    // The same shapes arriving in the opposite order give the same answer.
    expect(fold(pa(3), pb(2), pa(1))).toEqual(['Function:pb/R/f.R:dup']);
    expect(fold(pb(3), pa(2), pb(1))).toEqual(['Function:pa/R/f.R:dup']);
  });

  it('keeps every file of a package that is attached again, as one call attached them first', () => {
    const x1 = attached('Function:px/R/x.R:dup', at(1));
    const y1 = attached('Function:px/R/y.R:dup', at(1));
    const q2 = attached('Function:pq/R/f.R:dup', at(2));
    const x3 = attached('Function:px/R/x.R:dup', at(3));
    const y3 = attached('Function:px/R/y.R:dup', at(3));
    let merged: BindingRef[] = [];
    for (const b of [x1, y1, q2, x3, y3]) merged = rMergeBindings(merged, [b], 's');
    expect(ids(merged)).toEqual(['Function:pq/R/f.R:dup']);
    const r1 = attached('Function:pq/R/f.R:dup', at(1));
    const s2 = attached('Function:px/R/x.R:dup', at(2));
    const t2 = attached('Function:px/R/y.R:dup', at(2));
    const r3 = attached('Function:pq/R/f.R:dup', at(3));
    merged = [];
    for (const b of [r1, s2, t2, r3]) merged = rMergeBindings(merged, [b], 's');
    expect(ids(merged)).toEqual(['Function:px/R/x.R:dup', 'Function:px/R/y.R:dup']);
  });

  it('keeps every file of the one package the last call attaches: that ambiguity stays', () => {
    const old = attached('Function:lp/R/f.R:dup', at(1));
    const x = attached('Function:lp2/R/x.R:dup', at(2));
    const y = attached('Function:lp2/R/y.R:dup', at(2));
    expect(ids(rMergeBindings([old, y, x], [], 's'))).toEqual([
      'Function:lp2/R/x.R:dup',
      'Function:lp2/R/y.R:dup',
    ]);
  });

  it('keeps the whole tier when a binding has no call position', () => {
    const a = attached('Function:a/R/f.R:dup', at(1));
    const b = attached('Function:b/R/f.R:dup');
    expect(ids(rMergeBindings([a, b], [], 's'))).toEqual([
      'Function:a/R/f.R:dup',
      'Function:b/R/f.R:dup',
    ]);
  });

  it('leaves a name that one package defines, and the other tiers, as they were', () => {
    const only = attached('Function:lp/R/f.R:only', at(1));
    expect(ids(rMergeBindings([only], [], 's'))).toEqual(['Function:lp/R/f.R:only']);
    const named: BindingRef = {
      origin: 'import',
      def: { nodeId: 'Function:p/R/f.R:dup' } as SymbolDefinition,
      via: { atRange: at(9) } as ImportEdge,
    };
    const lp = attached('Function:lp/R/f.R:dup', at(1));
    const lp2 = attached('Function:lp2/R/f.R:dup', at(2));
    expect(ids(rMergeBindings([lp, lp2], [named], 's'))).toEqual(['Function:p/R/f.R:dup']);
  });
});
