import { describe, it, expect } from 'vitest';
import {
  computePostDominators,
  isExitReachableFromAllBlocks,
  postDominates,
} from '../../../src/core/ingestion/cfg/post-dominators.js';
import type {
  BasicBlockData,
  CfgEdgeData,
  FunctionCfg,
} from '../../../src/core/ingestion/cfg/types.js';

// U2 (#2085 M5) — post-dominators on the EXIT-rooted reverse CFG. Pinned on
// hand-built FunctionCfg literals with zero tree-sitter dependency, mirroring
// reaching-defs.test.ts / cfg-builder.test.ts. Post-dominance has crisp,
// well-known expected outputs per topology, so the expected ipdom values ARE
// the spec for the Cooper–Harvey–Kennedy iterative dominators implementation.

// ── hand-built CFG helper ───────────────────────────────────────────────────

function mkCfg(
  blockCount: number,
  edges: [number, number][],
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
  const cfgEdges: CfgEdgeData[] = edges.map(([from, to]) => ({ from, to, kind: 'seq' }));
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

const NONE = -1;

describe('computePostDominators — ipdom on the reverse CFG', () => {
  it('linear chain: each block is post-dominated by its successor', () => {
    // 0(entry) → 1 → 2 → 3(exit)
    const cfg = mkCfg(4, [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    const tree = computePostDominators(cfg);
    expect(tree.ipdom[3]).toBe(NONE); // exit (root) has no post-dominator above it
    expect(tree.ipdom[2]).toBe(3);
    expect(tree.ipdom[1]).toBe(2);
    expect(tree.ipdom[0]).toBe(1);

    expect(postDominates(tree, 3, 0)).toBe(true);
    expect(postDominates(tree, 2, 0)).toBe(true);
    expect(postDominates(tree, 0, 2)).toBe(false);
    expect(postDominates(tree, 1, 1)).toBe(true); // reflexive
  });

  it('diamond (if/else with join): the join post-dominates the branch, arms do not', () => {
    // 0(branch) → 1(then), 2(else); 1,2 → 3(join) → 4(exit)
    const cfg = mkCfg(5, [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
    ]);
    const tree = computePostDominators(cfg);
    expect(tree.ipdom[4]).toBe(NONE);
    expect(tree.ipdom[3]).toBe(4);
    expect(tree.ipdom[1]).toBe(3);
    expect(tree.ipdom[2]).toBe(3);
    expect(tree.ipdom[0]).toBe(3); // join post-dominates the branch, not an arm

    expect(postDominates(tree, 3, 0)).toBe(true);
    expect(postDominates(tree, 1, 0)).toBe(false); // `then` does NOT post-dominate the branch
    expect(postDominates(tree, 2, 0)).toBe(false);
    expect(postDominates(tree, 3, 1)).toBe(true);
  });

  it('while loop: the header post-dominates the body; back-edge does not break the tree', () => {
    // 0(entry) → 1(header) → 2(body) → 1; header → 3(exit)
    const cfg = mkCfg(4, [
      [0, 1],
      [1, 2],
      [2, 1],
      [1, 3],
    ]);
    const tree = computePostDominators(cfg);
    expect(tree.ipdom[3]).toBe(NONE);
    expect(tree.ipdom[1]).toBe(3);
    expect(tree.ipdom[2]).toBe(1); // every path from body to exit goes through the header
    expect(tree.ipdom[0]).toBe(1);

    expect(postDominates(tree, 1, 2)).toBe(true);
    expect(postDominates(tree, 3, 2)).toBe(true);
    expect(postDominates(tree, 2, 1)).toBe(false);
  });

  it('multiple returns collapsing to a single EXIT: exit post-dominates everything', () => {
    // 0(entry) → 1(cond) → 2(return), 3(return); 2,3 → 4(exit)
    const cfg = mkCfg(5, [
      [0, 1],
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
    ]);
    const tree = computePostDominators(cfg);
    expect(tree.ipdom[4]).toBe(NONE);
    expect(tree.ipdom[1]).toBe(4);
    expect(tree.ipdom[2]).toBe(4);
    expect(tree.ipdom[3]).toBe(4);
    expect(tree.ipdom[0]).toBe(1);
    for (const b of [0, 1, 2, 3]) expect(postDominates(tree, 4, b)).toBe(true);
  });

  it('exit-less infinite loop: blocks that cannot reach EXIT have no post-dominator (KTD5)', () => {
    // 0(entry) → 1 → 2 → 1 (no edge ever reaches exit block 3)
    const cfg = mkCfg(4, [
      [0, 1],
      [1, 2],
      [2, 1],
    ]);
    const tree = computePostDominators(cfg);
    expect(tree.ipdom[3]).toBe(NONE); // exit itself
    expect(tree.ipdom[0]).toBe(NONE); // cannot reach exit
    expect(tree.ipdom[1]).toBe(NONE);
    expect(tree.ipdom[2]).toBe(NONE);
    // No post-dominator means only reflexive post-dominance, and the climb must
    // terminate (no infinite loop) even on the cycle.
    expect(postDominates(tree, 3, 0)).toBe(false);
    expect(postDominates(tree, 0, 0)).toBe(true);
    expect(postDominates(tree, 1, 2)).toBe(false);
  });

  it('trivial single-block function (entry === exit) does not crash', () => {
    const cfg = mkCfg(1, [], { entry: 0, exit: 0 });
    const tree = computePostDominators(cfg);
    expect(tree.ipdom[0]).toBe(NONE);
    expect(postDominates(tree, 0, 0)).toBe(true);
  });

  it('is deterministic across runs', () => {
    const make = (): FunctionCfg =>
      mkCfg(5, [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
        [3, 4],
      ]);
    const a = computePostDominators(make());
    const b = computePostDominators(make());
    expect(a.ipdom).toEqual(b.ipdom);
  });
});

// ── post-dominance soundness precondition (#2188 review) ────────────────────
// EXIT must be reachable (forward) from every block reachable from ENTRY, else
// the EXIT-rooted reverse walk degenerates and CDG is unsound. The current TS
// visitor always satisfies this; the guard protects future / hand-built CFGs.
describe('isExitReachableFromAllBlocks', () => {
  it('holds for a normal single-EXIT diamond (every block reaches EXIT)', () => {
    const cfg = mkCfg(5, [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
    ]);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('holds for a loop whose header has a structural edge to EXIT', () => {
    // 0=entry → 1=header; header → 2=body → back to header; header → 3=exit.
    const cfg = mkCfg(4, [
      [0, 1],
      [1, 2],
      [2, 1],
      [1, 3],
    ]);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('fails when an entry-reachable region cannot reach EXIT (exit-less loop)', () => {
    // 0=entry → 1; 1↔2 spin forever with no edge to 3=exit. EXIT is unreachable
    // from the {1,2} region → post-dominance would be unsound there.
    const cfg = mkCfg(4, [
      [0, 1],
      [1, 2],
      [2, 1],
    ]);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false);
  });

  it('fails for the review counterexample (A→B, A→L, B→X→L→A; EXIT disconnected)', () => {
    // Indices: 0=A(entry), 1=B, 2=X, 3=L, 4=EXIT (disconnected). The A/B/X/L
    // cycle never reaches EXIT, so the precondition must reject it.
    const cfg = mkCfg(5, [
      [0, 1],
      [0, 3],
      [1, 2],
      [2, 3],
      [3, 0],
    ]);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(false);
  });

  it('ignores blocks unreachable from ENTRY (they need not reach EXIT)', () => {
    // 0=entry → 1=exit directly; 2 is an island unreachable from entry. The
    // island does not violate the precondition (it is never analyzed).
    const cfg = mkCfg(3, [[0, 1]], { entry: 0, exit: 1 });
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('holds for the single-block CFG (entry === exit)', () => {
    expect(isExitReachableFromAllBlocks(mkCfg(1, [], { entry: 0, exit: 0 }))).toBe(true);
  });
});
