import { describe, it, expect } from 'vitest';
import {
  augmentForPostDom,
  computeScc,
  wasAugmented,
} from '../../../src/core/ingestion/cfg/synthetic-escape.js';
import {
  computePostDominators,
  isExitReachableFromAllBlocks,
} from '../../../src/core/ingestion/cfg/post-dominators.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';
import type {
  BasicBlockData,
  CfgEdgeData,
  CfgEdgeKind,
  FunctionCfg,
} from '../../../src/core/ingestion/cfg/types.js';

// #2197 U1 — the synthetic-escape pass for CDG soundness. Hand-built CFGs (no
// tree-sitter). The pass restores EXIT reverse-reachability for a genuine
// exit-unreachable CYCLE (an unconditional `goto`-cycle / infinite loop) so the
// post-dom / CDG pass runs, WITHOUT masking construction errors (a branch-less
// trapping spin / a dangling dead-end block stays skipped) or perturbing sound
// functions (a no-op referential identity for terminating fns + escaped loops).
//
// The exact-edge-set pin is load-bearing: a WRONG escape representative still
// yields `CDG>0` and still passes the AC2 post-dominance property test, so each
// regression asserts the EXACT control-dependence set, not merely a non-empty one.

// ── hand-built CFG helper (edges carry a kind so CDG labels can be asserted) ──

function mkCfg(
  blockCount: number,
  edges: [number, number, CfgEdgeKind?][],
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
  const cfgEdges: CfgEdgeData[] = edges.map(([from, to, kind]) => ({
    from,
    to,
    kind: kind ?? 'seq',
  }));
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

const cdgSet = (cfg: FunctionCfg): string[] =>
  computeControlDependence(cfg)
    .edges.map((e) => `${e.controllerBlock}->${e.dependentBlock}:${e.label}`)
    .sort();

const syntheticEdges = (cfg: FunctionCfg, view: FunctionCfg): string[] =>
  view === cfg ? [] : view.edges.slice(cfg.edges.length).map((e) => `${e.from}->${e.to}`);

/**
 * The repro CFG, identical across C / C++ / C# / Go (verified by probe):
 *
 *   void handler(int a){ start: if (a > 0) { work(); } goto start; }
 *
 *   ENTRY=0  EXIT=1  b2 = `(a>0)` predicate  b3 = `work()`  b4 = `goto start`
 *   0→2 seq | 2→3 cond-true | 2→4 seq (false arm skips work) | 3→4 seq | 4→2 seq
 *
 * EXIT(1) has no predecessor — the back-edge 4→2 traps blocks 2,3,4 in a cycle
 * and EXIT is non-reverse-reachable, so without the pass `emitFileCdg` withholds
 * ALL control dependence for the whole function.
 */
const reproGotoCycle = (): FunctionCfg =>
  mkCfg(
    5,
    [
      [0, 2, 'seq'],
      [2, 3, 'cond-true'],
      [2, 4, 'seq'],
      [3, 4, 'seq'],
      [4, 2, 'seq'],
    ],
    { entry: 0, exit: 1 },
  );

describe('computeScc — pure deterministic SCC routine', () => {
  it('partitions a simple cycle and singletons; member lists are ascending', () => {
    // 0 → 1 ⇄ 2 → 3 ; SCCs: {0}, {1,2}, {3}
    const succ = [[1], [2], [1, 3], []];
    const { compOf, members } = computeScc(succ, 4);
    expect(compOf[1]).toBe(compOf[2]); // 1 and 2 share a component
    expect(compOf[0]).not.toBe(compOf[1]);
    expect(compOf[3]).not.toBe(compOf[1]);
    // the {1,2} component lists members ascending
    const cyc = members[compOf[1]];
    expect([...cyc]).toEqual([1, 2]);
  });

  it('is deterministic across runs (sorted adjacency)', () => {
    const succ = [[2, 1], [2], [1, 3], [4], []];
    const a = computeScc(succ, 5);
    const b = computeScc(succ, 5);
    expect(a.compOf).toEqual(b.compOf);
    expect(a.members.map((m) => [...m])).toEqual(b.members.map((m) => [...m]));
  });

  it('handles a self-loop as a singleton component', () => {
    const succ = [[1], [1], []]; // 1 self-loops
    const { members } = computeScc(succ, 3);
    expect(members.some((m) => m.length === 1 && m[0] === 1)).toBe(true);
  });
});

describe('augmentForPostDom — the goto-cycle repro (exact CDG edge set)', () => {
  it('bridges the cycle so EXIT is reachable and the EXACT CDG set is emitted', () => {
    const cfg = reproGotoCycle();
    // Before the pass: EXIT is unreachable from the trapped blocks.
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false);

    const view = augmentForPostDom(cfg);
    expect(wasAugmented(cfg, view)).toBe(true);
    // ONE synthetic escape, from the loop's controlling predicate (block 2) to
    // EXIT (block 1) — the `if (a>0)` branch is the only control point.
    expect(syntheticEdges(cfg, view)).toEqual(['2->1']);
    expect(isExitReachableFromAllBlocks(view)).toBe(true);

    // EXACT source-faithful CDG set — NOT merely `CDG>0` (a wrong representative
    // would still give a non-empty set). The `if` predicate (block 2) controls:
    //   work() (b3) on its TRUE arm;
    //   the goto (b4), reached on BOTH arms (2→3→4 and 2→4) → T and F;
    //   its OWN re-execution (b2), reached on both arms via the back-edge → T,F.
    expect(cdgSet(view)).toEqual(['2->2:F', '2->2:T', '2->3:T', '2->4:F', '2->4:T']);
  });

  it('the controller is the branch predicate, not an arbitrary cycle member', () => {
    const view = augmentForPostDom(reproGotoCycle());
    const synth = view.edges.slice(reproGotoCycle().edges.length);
    expect(synth).toHaveLength(1);
    // block 2 is the only block with ≥2 successors (the if-branch) — it must be
    // the escape source, not b3/b4 (the straight-line body / goto).
    expect(synth[0].from).toBe(2);
    expect(synth[0].to).toBe(1); // EXIT
  });
});

describe('augmentForPostDom — no-op for sound functions (referential identity)', () => {
  it('a terminating straight-line function is returned UNCHANGED (zero synthetic edges)', () => {
    const cfg = mkCfg(3, [
      [0, 1, 'seq'],
      [1, 2, 'seq'],
    ]);
    const view = augmentForPostDom(cfg);
    expect(view).toBe(cfg); // referential no-op
    expect(wasAugmented(cfg, view)).toBe(false);
  });

  it('an ordinary escaped while-loop is returned UNCHANGED', () => {
    // 0(entry) → 1(header); 1 → 2(body, T); 2 → 1 (back); 1 → 3(exit, F escape)
    const cfg = mkCfg(
      4,
      [
        [0, 1, 'seq'],
        [1, 2, 'cond-true'],
        [2, 1, 'loop-back'],
        [1, 3, 'cond-false'],
      ],
      { entry: 0, exit: 3 },
    );
    const view = augmentForPostDom(cfg);
    expect(view).toBe(cfg);
    // post-dom + CDG identical with and without the pass (the pass did nothing).
    expect(computePostDominators(view).ipdom).toEqual(computePostDominators(cfg).ipdom);
    expect(cdgSet(view)).toEqual(cdgSet(cfg));
  });

  it('a for-loop with a body branch is returned UNCHANGED', () => {
    // header(1) → body(2) → if(3) → {then(4)|else(5)} → back to header; 1→6 exit
    const cfg = mkCfg(
      7,
      [
        [0, 1, 'seq'],
        [1, 2, 'cond-true'],
        [2, 3, 'seq'],
        [3, 4, 'cond-true'],
        [3, 5, 'cond-false'],
        [4, 1, 'loop-back'],
        [5, 1, 'loop-back'],
        [1, 6, 'cond-false'],
      ],
      { entry: 0, exit: 6 },
    );
    expect(augmentForPostDom(cfg)).toBe(cfg);
  });
});

describe('augmentForPostDom — multi-SCC diverging switch (batch bridge)', () => {
  it('bridges BOTH exit-less SCCs in one batch → exit-reachable, CDG emitted', () => {
    // dispatch(2) → arm A goto-loop {3,4,5} | arm B goto-loop {6,7,8}; EXIT=1.
    // Each arm is a separate exit-less SCC with its own `if` branch (3 and 6).
    const cfg = mkCfg(
      9,
      [
        [0, 2, 'seq'],
        [2, 3, 'switch-case'],
        [2, 6, 'switch-case'],
        [3, 4, 'cond-true'],
        [3, 5, 'seq'],
        [4, 5, 'seq'],
        [5, 3, 'seq'],
        [6, 7, 'cond-true'],
        [6, 8, 'seq'],
        [7, 8, 'seq'],
        [8, 6, 'seq'],
      ],
      { entry: 0, exit: 1 },
    );
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false);
    const view = augmentForPostDom(cfg);
    // both arm predicates (3 and 6) escape to EXIT — neither arm left trapped.
    expect(syntheticEdges(cfg, view).sort()).toEqual(['3->1', '6->1']);
    expect(isExitReachableFromAllBlocks(view)).toBe(true);
    expect(computeControlDependence(view).edges.length).toBeGreaterThan(0);
  });
});

describe('augmentForPostDom — spine/ENTRY in the unreachable closure is not mis-skipped', () => {
  it('straight-line statements before the goto label still reach EXIT after the pass', () => {
    // ENTRY 0 → stmtA(2) → stmtB(3) → predicate(4) → {work(5)|goto(6)} → back(4)
    // The spine {0,2,3} is exit-unreachable too (it feeds the trap), but it must
    // NOT be flagged an anomaly — it reaches EXIT for free through the bridge.
    const cfg = mkCfg(
      7,
      [
        [0, 2, 'seq'],
        [2, 3, 'seq'],
        [3, 4, 'seq'],
        [4, 5, 'cond-true'],
        [4, 6, 'seq'],
        [5, 6, 'seq'],
        [6, 4, 'seq'],
      ],
      { entry: 0, exit: 1 },
    );
    const view = augmentForPostDom(cfg);
    expect(syntheticEdges(cfg, view)).toEqual(['4->1']); // bridge at the predicate
    expect(isExitReachableFromAllBlocks(view)).toBe(true); // spine + ENTRY all reach EXIT
  });
});

describe('augmentForPostDom — anti-masking (R2): construction anomalies stay skipped', () => {
  it('a dangling dead-end block (not in a cycle, no control point) is NOT bridged', () => {
    // ENTRY 0 → dead-end(1) with no out-edge; EXIT 2 unreachable from ENTRY.
    // No control point in the trapped region → not bridged → still unsound.
    const cfg = mkCfg(3, [[0, 1, 'seq']], { entry: 0, exit: 2 });
    const view = augmentForPostDom(cfg);
    expect(view).toBe(cfg); // refused to bridge
    expect(isExitReachableFromAllBlocks(view)).toBe(false); // skip path stays correct
  });

  it('a branch-less infinite spin (the disconnected-EXIT fixture shape) is NOT bridged', () => {
    // ENTRY 0 → 1 ⇄ 2 (branch-less spin); EXIT 3 disconnected. No control point
    // anywhere in the trap → refuse to bridge (indistinguishable from a real
    // construction error) → the existing soundness gate skips it.
    const cfg = mkCfg(
      4,
      [
        [0, 1, 'seq'],
        [1, 2, 'seq'],
        [2, 1, 'seq'],
      ],
      { entry: 0, exit: 3 },
    );
    const view = augmentForPostDom(cfg);
    expect(view).toBe(cfg);
    expect(isExitReachableFromAllBlocks(view)).toBe(false);
  });

  it('a MIXED cycle + separate dead-end: cycle bridged, residual dead-end keeps the whole fn skipped', () => {
    // ENTRY 0 branches to a recoverable goto-cycle {2,3,4} (branch at 2) AND to a
    // separate dead-end block 5. The cycle is bridged, but block 5 stays
    // exit-unreachable → the all-or-nothing gate skips the whole function (the
    // documented granularity decision: recover the cycle, surface the residual).
    const cfg = mkCfg(
      6,
      [
        [0, 2, 'cond-true'],
        [0, 5, 'cond-false'],
        [2, 3, 'cond-true'],
        [2, 4, 'seq'],
        [3, 4, 'seq'],
        [4, 2, 'seq'],
      ],
      { entry: 0, exit: 1 },
    );
    const view = augmentForPostDom(cfg);
    // the cycle WAS bridged (block 2 → EXIT)...
    expect(syntheticEdges(cfg, view)).toEqual(['2->1']);
    // ...but block 5 is still exit-unreachable → the whole function is skipped.
    expect(isExitReachableFromAllBlocks(view)).toBe(false);
  });
});

describe('augmentForPostDom — irreducible 2-entry loop (characterization)', () => {
  it('bridges the irreducible cycle reachability-sound (control point feeds it from outside)', () => {
    // ENTRY 0 → branch(2) → {3 | 4}; 3 ⇄ 4 form an irreducible 2-entry cycle with
    // NO internal branch. The control point (block 2) sits OUTSIDE the cycle, so
    // the escape attaches to the lowest-index cycle member (block 3). EXIT=1.
    const cfg = mkCfg(
      5,
      [
        [0, 2, 'seq'],
        [2, 3, 'cond-true'],
        [2, 4, 'seq'],
        [3, 4, 'seq'],
        [4, 3, 'seq'],
      ],
      { entry: 0, exit: 1 },
    );
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false);
    const view = augmentForPostDom(cfg);
    expect(syntheticEdges(cfg, view)).toEqual(['3->1']); // lowest-index member
    expect(isExitReachableFromAllBlocks(view)).toBe(true);
  });
});

describe('augmentForPostDom — persistence (analysis-only, never mutates input)', () => {
  it('does not mutate the input cfg.edges', () => {
    const cfg = reproGotoCycle();
    const before = cfg.edges.map((e) => `${e.from}->${e.to}:${e.kind}`);
    const beforeLen = cfg.edges.length;
    const view = augmentForPostDom(cfg);
    // the view carries the extra edge...
    expect(view.edges.length).toBe(beforeLen + 1);
    // ...but the ORIGINAL edges array is byte-identical (length + contents).
    expect(cfg.edges.length).toBe(beforeLen);
    expect(cfg.edges.map((e) => `${e.from}->${e.to}:${e.kind}`)).toEqual(before);
    // and the view is a distinct array (not aliasing the input).
    expect(view.edges).not.toBe(cfg.edges);
  });

  it('the no-op path returns the SAME object (no clone allocated)', () => {
    const cfg = mkCfg(3, [
      [0, 1, 'seq'],
      [1, 2, 'seq'],
    ]);
    expect(augmentForPostDom(cfg)).toBe(cfg);
  });
});
