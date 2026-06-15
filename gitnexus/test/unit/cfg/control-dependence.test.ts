import { describe, it, expect } from 'vitest';
import {
  computeControlDependence,
  type ControlDepEdge,
  type CdgLabel,
} from '../../../src/core/ingestion/cfg/control-dependence.js';
import {
  computePostDominators,
  isExitReachableFromAllBlocks,
  postDominates,
} from '../../../src/core/ingestion/cfg/post-dominators.js';
import { augmentForPostDom } from '../../../src/core/ingestion/cfg/synthetic-escape.js';
import type {
  BasicBlockData,
  CfgEdgeData,
  CfgEdgeKind,
  FunctionCfg,
} from '../../../src/core/ingestion/cfg/types.js';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { getProvider } from '../../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

// U3 (#2085 M5) — Ferrante §3.1.1 control dependence over the post-dom tree.
// Hand-built CFG literals plus real-parser regression tests. The labelled
// expected edge sets ARE the spec; the property test (AC2) cross-checks the
// tree-walk against a reference that computes post-dominance INDEPENDENTLY (by
// node-removal reachability, sharing NO code with post-dominators.ts), so a
// post-dominator *direction* bug cannot pass both (#2188 F4).

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
 * Build a successor adjacency list for a CFG (in-range edges only).
 */
function succsOf(cfg: FunctionCfg): number[][] {
  const n = cfg.blocks.length;
  const succs: number[][] = Array.from({ length: n }, () => []);
  for (const e of cfg.edges)
    if (e.from >= 0 && e.from < n && e.to >= 0 && e.to < n) succs[e.from].push(e.to);
  return succs;
}

/**
 * INDEPENDENT post-dominance via node-removal reachability — shares NO code with
 * post-dominators.ts (that is the whole point: it must catch a CHK *direction*
 * bug that a shared-substrate reference would mirror, #2188 F4). `p`
 * post-dominates `b` iff every path from `b` to EXIT passes through `p`:
 * reflexive (`p === b`), else true exactly when EXIT is unreachable from `b`
 * once `p` is removed (AND `b` can reach EXIT at all). Defined only for the
 * exit-reachable fixtures used below. A raw exit-unreachable cycle (#2188 F2)
 * would be unsound, so the AC2 set now feeds the synthetic-escape pass's
 * AUGMENTED view of every goto-cycle fixture (#2197 U1) — once bridged it IS
 * exit-reachable and the Ferrante walk must equal this independent reference.
 */
function independentPostDom(cfg: FunctionCfg, succs: number[][], p: number, b: number): boolean {
  if (p === b) return true;
  const exit = cfg.exitIndex;
  const reach = (avoid: number): boolean => {
    if (b === avoid) return false;
    const seen = new Set<number>([b]);
    const stack = [b];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === exit) return true;
      for (const y of succs[x]) {
        if (y === avoid || seen.has(y)) continue;
        seen.add(y);
        stack.push(y);
      }
    }
    return false;
  };
  // p post-dominates b ⇔ b reaches EXIT, but cannot reach it with p removed.
  return reach(-1) && !reach(p);
}

/**
 * Reference control-dependence pairs from the Ferrante definition, using the
 * INDEPENDENT post-dominance above: N is control-dependent on A iff some CFG
 * edge A→B has N post-dominating B while N does NOT strictly post-dominate A.
 * Label-agnostic (distinct "A->N" pairs) — the pure definition has no sense.
 */
function referencePairs(cfg: FunctionCfg): Set<string> {
  const n = cfg.blocks.length;
  const succs = succsOf(cfg);
  const pd = (x: number, y: number): boolean => independentPostDom(cfg, succs, x, y);
  const pairs = new Set<string>();
  for (let a = 0; a < n; a++) {
    for (const b of succs[a]) {
      if (pd(b, a)) continue; // edge is not a control point
      for (let nn = 0; nn < n; nn++) {
        const nPostDomB = pd(nn, b);
        const nStrictlyPostDomA = nn !== a && pd(nn, a);
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
    const { edges } = computeControlDependence(cfg);
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
    const { edges } = computeControlDependence(cfg);
    // use(x) (block 3) runs only when the guard condition is false → label 'F'
    expect(serAll(edges).sort()).toEqual(['1->2:T', '1->3:F']);
  });

  it('straight-line function (no branches) has no control dependence', () => {
    const cfg = mkCfg(3, [
      [0, 1, 'seq'],
      [1, 2, 'seq'],
    ]);
    expect(computeControlDependence(cfg).edges).toEqual([]);
  });

  it('while loop: the body depends on the header, and the header is control-dependent on itself', () => {
    // 0(entry) → 1(header); 1 → 2(body, T) , 1 → 3(exit, F); 2 → 1 (back-edge)
    const cfg = mkCfg(4, [
      [0, 1, 'seq'],
      [1, 2, 'cond-true'],
      [2, 1, 'loop-back'],
      [1, 3, 'cond-false'],
    ]);
    const { edges } = computeControlDependence(cfg);
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
    const { edges } = computeControlDependence(cfg);
    expect(serAll(edges).sort()).toEqual(['1->2:T', '1->3:T', '1->4:T']);
  });

  it('exit-less loop (KTD5): terminates and stays in-range, but the result is KNOWN-UNSOUND (#2188 F2)', () => {
    // No block can reach EXIT (block 3), so every ipdom is NO_IPDOM and the
    // Ferrante walk degenerates to one edge per control point. The termination /
    // in-range invariants MUST hold (the walk hits NO_IPDOM immediately). The
    // emitted dependence SET, however, is NOT a sound over-approximation: it both
    // drops real dependences and invents spurious ones in exit-unreachable
    // regions (#2188 F2). This test pins the degenerate output to document that
    // behavior, NOT to bless it; the labels here are likewise indeterminate
    // (no controller carries an explicit cond-true/cond-false arm, so the
    // fall-through complement resolves to 'F'). The current TS visitor never
    // produces such a region (every loop gets a structural header→loopExit edge).
    const cfg = mkCfg(4, [
      [0, 1, 'seq'],
      [1, 2, 'seq'],
      [2, 1, 'loop-back'],
    ]);
    const { edges } = computeControlDependence(cfg);
    expect(serAll(edges).sort()).toEqual(['0->1:F', '1->2:F', '2->1:F']);
    for (const e of edges) {
      expect(e.controllerBlock).toBeGreaterThanOrEqual(0);
      expect(e.controllerBlock).toBeLessThan(cfg.blocks.length);
      expect(e.dependentBlock).toBeGreaterThanOrEqual(0);
      expect(e.dependentBlock).toBeLessThan(cfg.blocks.length);
    }
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
    expect(serAll(computeControlDependence(make()).edges)).toEqual(
      serAll(computeControlDependence(make()).edges),
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
      // Escaped `goto`-cycle (#2197 U1): after the synthetic-escape pass the
      // exit-unreachable cycle is bridged and the dependence set becomes a SOUND
      // over-approximation, so it now joins the AC2 set (the obsolete
      // exit-unreachable exclusion is lifted — see the AUGMENTED-view note below).
      // Repro shape: ENTRY=0, EXIT=1, b2=`(a>0)` predicate, b3=`work()`,
      // b4=`goto start`; the `if` predicate (b2) is the only control point.
      gotoCycle: augmentForPostDom(
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
        ),
      ),
      // Spine before the goto label — ENTRY + straight-line stmts are in the
      // exit-unreachable closure but must reach EXIT after the bridge.
      gotoCycleSpine: augmentForPostDom(
        mkCfg(
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
        ),
      ),
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
      '%s: is exit-reachable from all blocks (the AC2 reference is well-defined)',
      (name) => {
        // Every AC2 fixture — including the AUGMENTED goto-cycle ones (#2197 U1)
        // — must be exit-reachable, else the node-removal reference is undefined.
        expect(isExitReachableFromAllBlocks(fixtures[name])).toBe(true);
      },
    );

    it.each(Object.keys(fixtures))(
      '%s: tree-walk pair set equals the brute-force reference',
      (name) => {
        const cfg = fixtures[name];
        const { edges } = computeControlDependence(cfg);
        const walkPairs = new Set(edges.map((e) => `${e.controllerBlock}->${e.dependentBlock}`));
        expect(walkPairs).toEqual(referencePairs(cfg));
      },
    );

    it.each(Object.keys(fixtures))(
      '%s: for every CFG edge, it yields a dependent IFF the target does not post-dominate the source',
      (name) => {
        const cfg = fixtures[name];
        const tree = computePostDominators(cfg);
        const { edges } = computeControlDependence(cfg);
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

describe('computeControlDependence — maxEdges materialization ceiling (#2188)', () => {
  // A switch dispatch yields three deduped CDG edges (1->2/3/4, all 'T').
  const switchCfg = (): FunctionCfg =>
    mkCfg(6, [
      [0, 1, 'seq'],
      [1, 2, 'switch-case'],
      [1, 3, 'switch-case'],
      [1, 4, 'switch-case'],
      [2, 5, 'break'],
      [3, 5, 'break'],
      [4, 5, 'break'],
    ]);

  it('stops at the ceiling and reports truncated (deterministic prefix)', () => {
    const r = computeControlDependence(switchCfg(), undefined, 2);
    expect(r.truncated).toBe(true);
    expect(r.edges).toHaveLength(2);
    // the prefix is still sorted/deduped, a valid subset of the full result
    for (const e of r.edges) expect(['T', 'F']).toContain(e.label);
  });

  it('maxEdges of 0 means unbounded (full result, not truncated)', () => {
    const r = computeControlDependence(switchCfg(), undefined, 0);
    expect(r.truncated).toBe(false);
    expect(serAll(r.edges).sort()).toEqual(['1->2:T', '1->3:T', '1->4:T']);
  });

  it('a ceiling at/above the true count is not truncated', () => {
    const r = computeControlDependence(switchCfg(), undefined, 3);
    expect(r.truncated).toBe(false);
    expect(r.edges).toHaveLength(3);
  });
});

describe('computeControlDependence — reverse-DF formulation regressions (#2195)', () => {
  // The Ferrante up-walk was replaced by the reverse-CFG post-dominance frontier
  // (Cytron/CFRWZ 1991; LLVM ReverseIDFCalculator / Joern CdgPass). These pin the
  // three invariants the rewrite must preserve: multi-label-per-pair, the
  // self-edge / NO_IPDOM seed guard, and linear (not quadratic) scaling.

  it('keeps BOTH senses when one controller reaches a dependent via opposite arms', () => {
    // Minimised goto-cycle shape: A (block 1) reaches X (block 2) by BOTH its true
    // arm and its false arm, with a third escape (1→3) so X does NOT post-dominate
    // A (else it would be a plain diamond join controlling nothing). The PDF must
    // union the label SET — the old (a, cur, label) dedup kept both rows — not
    // collapse the pair to a single sense.
    const cfg = mkCfg(
      4,
      [
        [0, 1, 'seq'],
        [1, 2, 'cond-true'],
        [1, 2, 'cond-false'],
        [1, 3, 'seq'], // escape so X(2) is not a post-dominator of A(1)
        [2, 3, 'seq'],
      ],
      { entry: 0, exit: 3 },
    );
    const { edges } = computeControlDependence(cfg);
    expect(serAll(edges).sort()).toEqual(['1->2:F', '1->2:T']);
  });

  it('a literal self-edge never invents a self control-dependence (PDF_local a!==x guard)', () => {
    // Standard while loop (header 1, body 2) PLUS a spurious LITERAL self-edge
    // 1→1. The header legitimately depends on itself via the body back-edge
    // (1->1:T is inherited through PDF_up), but the literal self in-edge must
    // contribute NOTHING: without the `a !== x` PDF_local guard it would seed a
    // bogus 1->1:F (the loop-back complement of the header's true arm).
    const cfg = mkCfg(4, [
      [0, 1, 'seq'],
      [1, 2, 'cond-true'],
      [2, 1, 'loop-back'],
      [1, 1, 'loop-back'], // spurious literal self-edge — must be ignored
      [1, 3, 'cond-false'],
    ]);
    const { edges } = computeControlDependence(cfg);
    expect(serAll(edges).sort()).toEqual(['1->1:T', '1->2:T']);
    expect(edges.some((e) => ser(e) === '1->1:F')).toBe(false);
  });

  it('scales linearly on a fan-into-chain (perf tripwire: was a Θ(N²) up-walk)', () => {
    // fanChain(N): block 0 fans one edge to every node of a length-(N-2) spine
    // whose ipdom chain tops out at EXIT. The old Ferrante up-walk re-climbed the
    // shared spine once per fan edge → Θ(N²) (~7.1s at N=16k); the reverse-DF form
    // is O(N+E+output) (~13ms). Coarse wall-clock tripwire, not a microbenchmark:
    // a revert to quadratic blows past the ceiling by >5×. post-dom is built
    // outside the timed region so this isolates the rewritten function.
    const N = 16000;
    const M = N - 2; // chain blocks 1..M; block 0 = fan source; block N-1 = EXIT
    const exit = N - 1;
    const edges: [number, number, CfgEdgeKind][] = [];
    for (let i = 1; i <= M; i++) {
      edges.push([0, i, 'switch-case']); // fan: 0 → every chain node
      edges.push([i, i === M ? exit : i + 1, 'seq']); // spine: i → i+1 (→ EXIT)
    }
    const cfg = mkCfg(N, edges, { entry: 0, exit });
    const postDom = computePostDominators(cfg); // built OUTSIDE the timed region
    const t0 = performance.now();
    const { edges: cdg } = computeControlDependence(cfg, postDom);
    const ms = performance.now() - t0;
    // Block 0 controls every chain node EXCEPT the last (M): the sole edge into
    // EXIT is M→exit, so M post-dominates the whole fan (ipdom[0]===M) and is
    // controlled by nothing. The other M-1 spine nodes are each 0-controlled.
    // Assert IDENTITY too (not just count) so a fast-but-wrong reimplementation
    // emitting M-1 mis-attributed edges can't pass on length alone.
    expect(cdg).toHaveLength(M - 1);
    expect(cdg.every((e) => e.controllerBlock === 0)).toBe(true);
    expect(cdg.every((e) => e.dependentBlock >= 1 && e.dependentBlock < M)).toBe(true);
    expect(new Set(cdg.map((e) => e.dependentBlock)).size).toBe(M - 1); // all distinct
    expect(ms).toBeLessThan(1000);
  });
});

describe('#2188 F1 — branch-label correctness on the REAL TS visitor (regression)', () => {
  // The label is the AC3 "under what condition does X run?" answer. The bug:
  // branchSense inferred it from the edge KIND alone, but the M1 visitor wires a
  // condition's fall-through FALSE arm as `seq`/`loop-back` (not `cond-false`),
  // so guard clauses / loop break got 'T' instead of 'F'. These tests run the
  // REAL parser+visitor (the hand-built tests above used a fictional `cond-false`
  // edge and could not catch the regression).
  const tsVisitor = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  const parser = new Parser();
  if (tsVisitor) parser.setLanguage(TypeScript.typescript);

  function cdgOf(code: string): { cfg: FunctionCfg; edges: readonly ControlDepEdge[] } {
    if (!tsVisitor) throw new Error('no cfgVisitor');
    const cfgs = collectFunctionCfgs(parser.parse(code).rootNode, tsVisitor, 't.ts').cfgs;
    expect(cfgs.length).toBe(1);
    return { cfg: cfgs[0], edges: computeControlDependence(cfgs[0]).edges };
  }
  const labelOf = (
    edges: readonly ControlDepEdge[],
    controller: number,
    dependent: number,
  ): CdgLabel | undefined =>
    edges.find((e) => e.controllerBlock === controller && e.dependentBlock === dependent)?.label;

  it("guard clause: post-guard body runs on the guard's FALSE (seq) arm → 'F'", () => {
    const { cfg, edges } = cdgOf(`function f(x){ if (!ok(x)) return; use(x); }`);
    const guard = cfg.blocks.find((b) => b.text.includes('ok(x)'))!;
    const use = cfg.blocks.find((b) => b.text.includes('use(x)'))!;
    expect(labelOf(edges, guard.index, use.index)).toBe('F');
  });

  it("do/while: body runs on the bottom-test's TRUE (loop-back) arm → 'T'", () => {
    const { cfg, edges } = cdgOf(`function f(){ do { body(); } while (c()); }`);
    const test = cfg.blocks.find((b) => b.text.includes('c()'))!;
    const body = cfg.blocks.find((b) => b.text.includes('body()'))!;
    expect(labelOf(edges, test.index, body.index)).toBe('T');
  });

  it("while+break: post-break tail runs on the if's FALSE (seq) arm → 'F'", () => {
    const { cfg, edges } = cdgOf(`function f(o,i){ while (o) { if (i) break; tail(); } }`);
    const ifCond = cfg.blocks.find((b) => b.text === '(i)')!;
    const tail = cfg.blocks.find((b) => b.text.includes('tail()'))!;
    expect(labelOf(edges, ifCond.index, tail.index)).toBe('F');
  });

  it("if/else still labels both arms correctly (no regression) → then 'T', else 'F'", () => {
    const { cfg, edges } = cdgOf(`function f(x){ if (x) { a(); } else { b(); } }`);
    const cond = cfg.blocks.find((b) => b.text === '(x)')!;
    const thenB = cfg.blocks.find((b) => b.text.includes('a()'))!;
    const elseB = cfg.blocks.find((b) => b.text.includes('b()'))!;
    expect(labelOf(edges, cond.index, thenB.index)).toBe('T');
    expect(labelOf(edges, cond.index, elseB.index)).toBe('F');
  });
});
