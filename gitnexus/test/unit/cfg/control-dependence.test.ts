import { describe, it, expect } from 'vitest';
import {
  computeControlDependence,
  type ControlDepEdge,
} from '../../../src/core/ingestion/cfg/control-dependence.js';
import {
  computePostDominators,
  postDominates,
} from '../../../src/core/ingestion/cfg/post-dominators.js';
import type {
  BasicBlockData,
  CfgEdgeData,
  CfgEdgeKind,
  FunctionCfg,
} from '../../../src/core/ingestion/cfg/types.js';

// U3 (#2085 M5) — Ferrante §3.1.1 control dependence over the post-dom tree.
// Hand-built CFG literals, zero tree-sitter dependency. The labelled expected
// edge sets ARE the spec; the property test (AC2) cross-checks the tree-walk
// against an INDEPENDENT brute-force reference derived straight from the
// post-dominance definition, so an algorithm bug cannot pass both.

// ── hand-built CFG helper (edges carry a kind so labels can be asserted) ─────

function mkCfg(
  blockCount: number,
  edges: [number, number, CfgEdgeKind][],
  opts: { entry?: number; exit?: number } = {},
): FunctionCfg {
  const entry = opts.entry ?? 0;
  const exit = opts.exit ?? blockCount - 1;
  const blocks: BasicBlockData[] = Array.from({ length: blockCount }, (_, i) => ({
    index: i,
    startLine: i + 1,
    endLine: i + 1,
    text: '',
    kind: i === entry ? 'entry' : i === exit ? 'exit' : 'normal',
  }));
  const cfgEdges: CfgEdgeData[] = edges.map(([from, to, kind]) => ({ from, to, kind }));
  return {
    filePath: 't.ts',
    functionStartLine: 1,
    functionStartColumn: 0,
    entryIndex: entry,
    exitIndex: exit,
    blocks,
    edges: cfgEdges,
  };
}

const ser = (e: ControlDepEdge): string => `${e.controllerBlock}->${e.dependentBlock}:${e.label}`;
const serAll = (edges: readonly ControlDepEdge[]): string[] => edges.map(ser);

/**
 * Independent reference: N is control-dependent on A iff some CFG edge A→B has
 * N post-dominating B while N does NOT strictly post-dominate A (Ferrante's
 * definition, computed by membership rather than a tree walk). Returns the set
 * of distinct "A->N" pairs (label-agnostic — the pure definition has no sense).
 */
function referencePairs(cfg: FunctionCfg): Set<string> {
  const tree = computePostDominators(cfg);
  const n = cfg.blocks.length;
  const succs: number[][] = Array.from({ length: n }, () => []);
  for (const e of cfg.edges)
    if (e.from >= 0 && e.from < n && e.to >= 0 && e.to < n) succs[e.from].push(e.to);
  const pairs = new Set<string>();
  for (let a = 0; a < n; a++) {
    for (const b of succs[a]) {
      if (postDominates(tree, b, a)) continue; // edge is not a control point
      for (let nn = 0; nn < n; nn++) {
        const nPostDomB = postDominates(tree, nn, b);
        const nStrictlyPostDomA = nn !== a && postDominates(tree, nn, a);
        if (nPostDomB && !nStrictlyPostDomA) pairs.add(`${a}->${nn}`);
      }
    }
  }
  return pairs;
}

describe('computeControlDependence — Ferrante §3.1.1', () => {
  it('diamond: each arm is control-dependent on the branch with its own T/F label', () => {
    // 0(branch) → 1(then, T), 2(else, F); 1,2 → 3(join) → 4(exit)
    const cfg = mkCfg(5, [
      [0, 1, 'cond-true'],
      [0, 2, 'cond-false'],
      [1, 3, 'seq'],
      [2, 3, 'seq'],
      [3, 4, 'seq'],
    ]);
    const edges = computeControlDependence(cfg);
    expect(serAll(edges).sort()).toEqual(['0->1:T', '0->2:F']);
    // the join (3) post-dominates the branch, so it depends on nothing
    expect(edges.some((e) => e.dependentBlock === 3)).toBe(false);
  });

  it('guard clause: the post-guard body is control-dependent on the guard (the #559/#2086 case)', () => {
    // function f(x){ if(!ok(x)) return; use(x); }
    // 0(entry) → 1(guard); 1 → 2(return, T) , 1 → 3(use, F); 2,3 → 4(exit)
    const cfg = mkCfg(5, [
      [0, 1, 'seq'],
      [1, 2, 'cond-true'], // !ok(x) → return
      [1, 3, 'cond-false'], // else → use(x)
      [2, 4, 'return'],
      [3, 4, 'seq'],
    ]);
    const edges = computeControlDependence(cfg);
    // use(x) (block 3) runs only when the guard condition is false → label 'F'
    expect(serAll(edges).sort()).toEqual(['1->2:T', '1->3:F']);
  });

  it('straight-line function (no branches) has no control dependence', () => {
    const cfg = mkCfg(3, [
      [0, 1, 'seq'],
      [1, 2, 'seq'],
    ]);
    expect(computeControlDependence(cfg)).toEqual([]);
  });

  it('while loop: the body depends on the header, and the header is control-dependent on itself', () => {
    // 0(entry) → 1(header); 1 → 2(body, T) , 1 → 3(exit, F); 2 → 1 (back-edge)
    const cfg = mkCfg(4, [
      [0, 1, 'seq'],
      [1, 2, 'cond-true'],
      [2, 1, 'loop-back'],
      [1, 3, 'cond-false'],
    ]);
    const edges = computeControlDependence(cfg);
    // body(2) control-dep on header(1); header(1) control-dep on itself (the
    // loop predicate gates its own re-execution — standard PDG behavior).
    expect(serAll(edges).sort()).toEqual(['1->1:T', '1->2:T']);
  });

  it('switch: every case body is control-dependent on the dispatch (all T in M5)', () => {
    // 0(entry) → 1(dispatch); 1 → 2,3,4 (cases); 2,3,4 → 5(exit)
    const cfg = mkCfg(6, [
      [0, 1, 'seq'],
      [1, 2, 'switch-case'],
      [1, 3, 'switch-case'],
      [1, 4, 'switch-case'],
      [2, 5, 'break'],
      [3, 5, 'break'],
      [4, 5, 'break'],
    ]);
    const edges = computeControlDependence(cfg);
    expect(serAll(edges).sort()).toEqual(['1->2:T', '1->3:T', '1->4:T']);
  });

  it('is deterministic (stable sorted order across runs)', () => {
    const make = (): FunctionCfg =>
      mkCfg(5, [
        [0, 1, 'cond-true'],
        [0, 2, 'cond-false'],
        [1, 3, 'seq'],
        [2, 3, 'seq'],
        [3, 4, 'seq'],
      ]);
    expect(serAll(computeControlDependence(make()))).toEqual(
      serAll(computeControlDependence(make())),
    );
  });

  describe('AC2 — a control dependence exists iff post-dominance fails for the branch', () => {
    const fixtures: Record<string, FunctionCfg> = {
      diamond: mkCfg(5, [
        [0, 1, 'cond-true'],
        [0, 2, 'cond-false'],
        [1, 3, 'seq'],
        [2, 3, 'seq'],
        [3, 4, 'seq'],
      ]),
      guard: mkCfg(5, [
        [0, 1, 'seq'],
        [1, 2, 'cond-true'],
        [1, 3, 'cond-false'],
        [2, 4, 'return'],
        [3, 4, 'seq'],
      ]),
      loop: mkCfg(4, [
        [0, 1, 'seq'],
        [1, 2, 'cond-true'],
        [2, 1, 'loop-back'],
        [1, 3, 'cond-false'],
      ]),
      // nested if: outer branch (0) → inner branch (1) or outer-else (5);
      // inner branch → 2/3 → inner join (4); 4 and 5 → outer join (6, exit).
      nestedIf: mkCfg(
        7,
        [
          [0, 1, 'cond-true'],
          [0, 5, 'cond-false'],
          [1, 2, 'cond-true'],
          [1, 3, 'cond-false'],
          [2, 4, 'seq'],
          [3, 4, 'seq'],
          [4, 6, 'seq'],
          [5, 6, 'seq'],
        ],
        { entry: 0, exit: 6 },
      ),
      switchStmt: mkCfg(6, [
        [0, 1, 'seq'],
        [1, 2, 'switch-case'],
        [1, 3, 'switch-case'],
        [1, 4, 'switch-case'],
        [2, 5, 'break'],
        [3, 5, 'break'],
        [4, 5, 'break'],
      ]),
    };

    it.each(Object.keys(fixtures))(
      '%s: tree-walk pair set equals the brute-force reference',
      (name) => {
        const cfg = fixtures[name];
        const edges = computeControlDependence(cfg);
        const walkPairs = new Set(edges.map((e) => `${e.controllerBlock}->${e.dependentBlock}`));
        expect(walkPairs).toEqual(referencePairs(cfg));
      },
    );

    it.each(Object.keys(fixtures))(
      '%s: for every CFG edge, it yields a dependent IFF the target does not post-dominate the source',
      (name) => {
        const cfg = fixtures[name];
        const tree = computePostDominators(cfg);
        const edges = computeControlDependence(cfg);
        for (const e of cfg.edges) {
          const failsPostDom = !postDominates(tree, e.to, e.from);
          // does THIS edge's source appear as a controller with at least one
          // dependent reachable from its target? Equivalent statement of AC2:
          // post-dominance failing for (from→to) ⇔ `from` is a control point.
          const fromIsControlPoint = edges.some((c) => c.controllerBlock === e.from);
          if (failsPostDom) {
            expect(
              fromIsControlPoint,
              `${name}: edge ${e.from}->${e.to} should make ${e.from} a control point`,
            ).toBe(true);
          }
          // and a self-post-dominating edge (to post-dominates from) can never
          // be the SOLE reason a block is a control point: if from has only
          // post-dominating successors it controls nothing.
        }
      },
    );
  });
});
