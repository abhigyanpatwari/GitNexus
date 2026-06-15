/**
 * #2201 — differential equivalence harness for the reaching-defs solvers.
 *
 * The SSA-sparse rewrite must be BYTE-IDENTICAL to the retained dense GEN/KILL
 * oracle ({@link computeReachingDefsDense}). This file is the permanent gate:
 * a seeded random-CFG generator drives both solvers and a structural comparator
 * asserts identical status / bindings / sorted facts / def-use telemetry.
 *
 * In U1 both sides run the dense oracle (self-equivalence + corpus-coverage
 * sanity); U5 flips the second solver to {@link computeReachingDefs} (sparse)
 * — the single change that turns this into the real equivalence gate.
 *
 * The corpus deliberately covers the shapes where a may-reaching-defs rewrite
 * is most likely to diverge: loops + irreducible (goto) topology, throw edges
 * (IN∪allDefs handler semantics), may-defs (gen-without-kill), shadowed
 * bindings, unreachable blocks, multi-predecessor joins, and the maxFacts /
 * maxBlockVisits truncation postures (KTD6 — the truncated SUBSET depends on
 * pre-sort emission order, so it must match too).
 *
 * Default corpus is CI-fast; GITNEXUS_RD_FUZZ_N raises it (the ≥1M run the
 * plan calls for) for a deep local/CI-shard pass.
 */
import { describe, it, expect } from 'vitest';
import {
  computeReachingDefs,
  computeReachingDefsDense,
  computeReachingDefsSparse,
  type FunctionDefUse,
  type ReachingDefsLimits,
} from '../../../src/core/ingestion/cfg/reaching-defs.js';
import type {
  BindingEntry,
  BasicBlockData,
  CfgEdgeData,
  CfgEdgeKind,
  FunctionCfg,
  StatementFacts,
} from '../../../src/core/ingestion/cfg/types.js';

type Solver = (cfg: FunctionCfg, limits?: ReachingDefsLimits) => FunctionDefUse;

// ── deterministic PRNG (mulberry32) ───────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NON_THROW_KINDS: CfgEdgeKind[] = [
  'seq',
  'cond-true',
  'cond-false',
  'loop-back',
  'break',
  'continue',
  'return',
  'switch-case',
  'fallthrough',
];

// ── random CFG generator ───────────────────────────────────────────────────
interface GenOpts {
  maxBlocks: number;
  maxBindings: number;
  maxStmtsPerBlock: number;
  pNoBindings: number; // chance the whole CFG has bindings:undefined (→ no-facts)
  pThrowEdge: number;
  pMayDef: number;
  pExtraEdge: number; // per-block chance of an extra random edge
  pShadowName: number;
}

const DEFAULT_GEN: GenOpts = {
  // Span both sides of the production SSA dispatch threshold (SSA_MIN_BLOCKS=16):
  // CFGs below it route the auto-dispatcher (computeReachingDefs) to dense, those
  // above with a reachable loop route it to the SSA path — so the corpus
  // differentially exercises BOTH branches of computeInSetsAuto, not just the
  // forced-SSA computeReachingDefsSparse entry. See the hadLargeLoop coverage
  // guard below.
  maxBlocks: 36,
  maxBindings: 8,
  maxStmtsPerBlock: 4,
  pNoBindings: 0.03,
  pThrowEdge: 0.12,
  pMayDef: 0.18,
  pExtraEdge: 0.9,
  pShadowName: 0.4,
};

function genCfg(seed: number, opts: GenOpts = DEFAULT_GEN): FunctionCfg {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const n = 1 + int(opts.maxBlocks); // ≥1 block (entry)

  // bindings — small name pool so shadowing collisions happen; distinct
  // declLine/declColumn keep non-synthetic bindings' keys distinct.
  const noBindings = rnd() < opts.pNoBindings;
  const nBindings = noBindings ? 0 : int(opts.maxBindings + 1);
  const namePool = ['a', 'b', 'c', 'd', 'e'];
  const kinds: BindingEntry['kind'][] = ['var', 'let', 'const', 'param', 'catch'];
  const bindings: BindingEntry[] = [];
  for (let i = 0; i < nBindings; i++) {
    const shadow = rnd() < opts.pShadowName;
    bindings.push({
      name: shadow ? namePool[int(namePool.length)] : `v${i}`,
      declLine: 100 + i,
      declColumn: i,
      kind: kinds[int(kinds.length)],
      ...(rnd() < 0.08 ? { synthetic: true } : {}),
    });
  }

  const pickBindings = (max: number): number[] => {
    if (nBindings === 0) return [];
    const out: number[] = [];
    const count = int(max + 1);
    for (let k = 0; k < count; k++) out.push(int(nBindings));
    return out;
  };

  // blocks (block 0 = entry; some blocks get no statements like synthetic
  // ENTRY/EXIT to exercise the skip paths).
  const blocks: BasicBlockData[] = [];
  for (let b = 0; b < n; b++) {
    const stmtCount = b === 0 && rnd() < 0.5 ? int(2) : int(opts.maxStmtsPerBlock + 1);
    const statements: StatementFacts[] = [];
    for (let i = 0; i < stmtCount; i++) {
      const defs = pickBindings(2);
      const uses = pickBindings(3);
      const mayDefs = rnd() < opts.pMayDef ? pickBindings(1) : [];
      statements.push({
        line: b * 100 + i + 1,
        defs,
        uses,
        ...(mayDefs.length ? { mayDefs } : {}),
      });
    }
    blocks.push({
      index: b,
      startLine: b * 100,
      endLine: b * 100 + stmtCount,
      text: `B${b}`,
      kind: b === 0 ? 'entry' : b === n - 1 ? 'exit' : 'normal',
      // bindings:undefined ⇒ no-facts: drop statements entirely so it mirrors a
      // pre-M2 CFG (the solver keys no-facts off cfg.bindings, but a realistic
      // no-facts CFG also lacks statements).
      ...(noBindings ? {} : { statements }),
    });
  }

  // edges — a probabilistic spine (entry chain) for reachability + random
  // extra edges that produce loops, irreducible topology, and unreachable
  // blocks. Throw edges target a random handler block.
  const edges: CfgEdgeData[] = [];
  const addEdge = (from: number, to: number, kind: CfgEdgeKind) => {
    if (from >= 0 && from < n && to >= 0 && to < n) edges.push({ from, to, kind });
  };
  for (let b = 0; b < n - 1; b++) {
    if (rnd() < 0.75) addEdge(b, b + 1, 'seq');
  }
  for (let b = 0; b < n; b++) {
    if (rnd() < opts.pExtraEdge) {
      const to = int(n); // any target → forward / back / self / cross edges
      const throwIt = rnd() < opts.pThrowEdge;
      addEdge(b, to, throwIt ? 'throw' : NON_THROW_KINDS[int(NON_THROW_KINDS.length)]);
    }
  }

  return {
    filePath: 'fuzz.ts',
    functionStartLine: 1,
    functionEndLine: n * 100,
    functionStartColumn: 0,
    entryIndex: 0,
    exitIndex: n - 1,
    blocks,
    edges,
    ...(noBindings ? {} : { bindings }),
  };
}

// ── hand-built canonical hard CFGs (guaranteed shape coverage) ─────────────
// These pin the gnarly shapes the random generator hits only probabilistically.
function canonicalHardCfgs(): FunctionCfg[] {
  const mk = (
    blocks: BasicBlockData[],
    edges: CfgEdgeData[],
    bindings: BindingEntry[],
  ): FunctionCfg => ({
    filePath: 'canon.ts',
    functionStartLine: 1,
    functionEndLine: 999,
    functionStartColumn: 0,
    entryIndex: 0,
    exitIndex: blocks.length - 1,
    blocks,
    edges,
    bindings,
  });
  const bind = (name: string, line: number): BindingEntry => ({
    name,
    declLine: line,
    declColumn: 0,
    kind: 'let',
  });
  const blk = (index: number, statements: StatementFacts[]): BasicBlockData => ({
    index,
    startLine: index * 10,
    endLine: index * 10 + statements.length,
    text: `B${index}`,
    kind: index === 0 ? 'entry' : 'normal',
    statements,
  });
  const st = (
    line: number,
    defs: number[],
    uses: number[],
    mayDefs?: number[],
  ): StatementFacts => ({
    line,
    defs,
    uses,
    ...(mayDefs ? { mayDefs } : {}),
  });

  const out: FunctionCfg[] = [];

  // (1) Irreducible two-entry loop: 0→1, 0→2, 1→2, 2→1. binding x def in 1, use in 2 & 1.
  out.push(
    mk(
      [blk(0, [st(1, [0], [])]), blk(1, [st(2, [0], [0])]), blk(2, [st(3, [], [0])])],
      [
        { from: 0, to: 1, kind: 'cond-true' },
        { from: 0, to: 2, kind: 'cond-false' },
        { from: 1, to: 2, kind: 'seq' },
        { from: 2, to: 1, kind: 'loop-back' },
      ],
      [bind('x', 1)],
    ),
  );

  // (2) Self-loop with may-def: block 1 loops to itself; x may-def + use.
  out.push(
    mk(
      [blk(0, [st(1, [0], [])]), blk(1, [st(2, [], [0], [0])])],
      [
        { from: 0, to: 1, kind: 'seq' },
        { from: 1, to: 1, kind: 'loop-back' },
      ],
      [bind('x', 1)],
    ),
  );

  // (3) try/catch throw edge: 0 (x=1), 1 (x=parse; x=normalize) -throw-> 2 (use x).
  out.push(
    mk(
      [
        blk(0, [st(1, [0], [])]),
        blk(1, [st(2, [0], []), st(3, [0], [0])]),
        blk(2, [st(4, [], [0])]),
      ],
      [
        { from: 0, to: 1, kind: 'seq' },
        { from: 1, to: 2, kind: 'seq' },
        { from: 1, to: 2, kind: 'throw' },
      ],
      [bind('x', 1)],
    ),
  );

  // (4) Diamond merge: both arm defs reach the join use.
  out.push(
    mk(
      [
        blk(0, [st(1, [], [])]),
        blk(1, [st(2, [0], [])]),
        blk(2, [st(3, [0], [])]),
        blk(3, [st(4, [], [0])]),
      ],
      [
        { from: 0, to: 1, kind: 'cond-true' },
        { from: 0, to: 2, kind: 'cond-false' },
        { from: 1, to: 3, kind: 'seq' },
        { from: 2, to: 3, kind: 'seq' },
      ],
      [bind('x', 1)],
    ),
  );

  // (5) Unreachable block carrying a def (block 2 not reachable from entry).
  out.push(
    mk(
      [blk(0, [st(1, [0], [0])]), blk(1, [st(2, [], [0])]), blk(2, [st(3, [0], [0])])],
      [{ from: 0, to: 1, kind: 'seq' }],
      [bind('x', 1)],
    ),
  );

  // (6) Back-edge into the ENTRY block: 0 (def+use x) → 1 (def+use x) → 0 (loop
  // back to entry) and 1 → 2 (exit, use x). The SSA solver's synthetic pre-entry
  // node exists precisely for this — the entry is a loop header, so x's loop-
  // carried def must reach the entry's own use. Pins that path deterministically.
  out.push(
    mk(
      [blk(0, [st(1, [0], [0])]), blk(1, [st(2, [0], [0])]), blk(2, [st(3, [], [0])])],
      [
        { from: 0, to: 1, kind: 'seq' },
        { from: 1, to: 0, kind: 'loop-back' },
        { from: 1, to: 2, kind: 'cond-false' },
      ],
      [bind('x', 1)],
    ),
  );

  // (7) Malformed input: an OUT-OF-RANGE binding index (≥ nBindings, e.g. from a
  // corrupted/stale durable store) in a looping CFG. The dense solver tolerates
  // it (its lattice is a Map keyed by index); the SSA path must fall back to
  // dense rather than crash its nBindings-sized arrays. Asserting byte-identity
  // here pins that gate — without it, the SSA path throws and the differential
  // comparison can never reach this divergent input (the generator only ever
  // emits in-range indices).
  out.push(
    mk(
      [blk(0, [st(1, [0], [])]), blk(1, [st(2, [3], [3])]), blk(2, [st(3, [], [0])])],
      [
        { from: 0, to: 1, kind: 'seq' },
        { from: 1, to: 1, kind: 'loop-back' },
        { from: 1, to: 2, kind: 'cond-false' },
      ],
      [bind('x', 1)], // nBindings = 1, so binding index 3 in block 1 is out of range
    ),
  );

  return out;
}

// ── structural comparator ──────────────────────────────────────────────────
function serializeFact(f: FunctionDefUse['facts'][number]): string {
  return (
    `${f.def.blockIndex}:${f.def.stmtIndex}@${f.def.line}` +
    `->${f.use.blockIndex}:${f.use.stmtIndex}@${f.use.line}#${f.bindingIdx}`
  );
}

/** Returns null when byte-identical, else a human-readable first divergence. */
function diffDefUse(a: FunctionDefUse, b: FunctionDefUse): string | null {
  if (a.status !== b.status) return `status: ${a.status} vs ${b.status}`;
  if (a.defCount !== b.defCount) return `defCount: ${a.defCount} vs ${b.defCount}`;
  if (a.useCount !== b.useCount) return `useCount: ${a.useCount} vs ${b.useCount}`;
  if (a.bindings.length !== b.bindings.length) {
    return `bindings.length: ${a.bindings.length} vs ${b.bindings.length}`;
  }
  if (a.facts.length !== b.facts.length) {
    return `facts.length: ${a.facts.length} vs ${b.facts.length}`;
  }
  for (let i = 0; i < a.facts.length; i++) {
    const fa = serializeFact(a.facts[i]);
    const fb = serializeFact(b.facts[i]);
    if (fa !== fb) return `fact[${i}]: ${fa} vs ${fb}`;
  }
  return null;
}

// ── corpus shape classifier (coverage guard) ───────────────────────────────
interface ShapeFlags {
  hasLoop: boolean;
  hasThrow: boolean;
  hasMayDef: boolean;
  hasShadow: boolean;
  hasMultiPred: boolean;
  hasUnreachable: boolean;
  // ≥16-block CFG (SSA_MIN_BLOCKS) with a loop reachable from entry — the exact
  // shape the production dispatcher (computeInSetsAuto) sends to the SSA solver.
  // Asserting it proves the auto-dispatcher's SSA branch is differentially fuzzed.
  hadLargeLoop: boolean;
  hadComputed: boolean;
  hadTruncated: boolean;
  hadNoFacts: boolean;
}

function classify(cfg: FunctionCfg, flags: ShapeFlags): void {
  const n = cfg.blocks.length;
  if (cfg.edges.some((e) => e.kind === 'throw')) flags.hasThrow = true;
  if (cfg.blocks.some((b) => b.statements?.some((s) => s.mayDefs?.length))) flags.hasMayDef = true;
  if (cfg.bindings) {
    const names = cfg.bindings.map((b) => b.name);
    if (new Set(names).size < names.length) flags.hasShadow = true;
  }
  const predCount = new Array(n).fill(0);
  for (const e of cfg.edges) if (e.to >= 0 && e.to < n) predCount[e.to]++;
  if (predCount.some((c) => c >= 2)) flags.hasMultiPred = true;

  // cycle detection (DFS rec-stack) over the whole graph
  const succ: number[][] = Array.from({ length: n }, () => []);
  for (const e of cfg.edges)
    if (e.from >= 0 && e.from < n && e.to >= 0 && e.to < n) succ[e.from].push(e.to);
  const color = new Array(n).fill(0); // 0=white 1=gray 2=black
  const hasCycleFrom = (start: number): boolean => {
    const stack: { node: number; idx: number }[] = [{ node: start, idx: 0 }];
    color[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.idx < succ[top.node].length) {
        const nx = succ[top.node][top.idx++];
        if (color[nx] === 1) return true;
        if (color[nx] === 0) {
          color[nx] = 1;
          stack.push({ node: nx, idx: 0 });
        }
      } else {
        color[top.node] = 2;
        stack.pop();
      }
    }
    return false;
  };
  for (let s = 0; s < n; s++) if (color[s] === 0 && hasCycleFrom(s)) flags.hasLoop = true;

  // reachability from entry
  const seen = new Array(n).fill(false);
  const q = [cfg.entryIndex];
  seen[cfg.entryIndex] = true;
  while (q.length) {
    const x = q.pop()!;
    for (const y of succ[x]) if (!seen[y]) ((seen[y] = true), q.push(y));
  }
  if (seen.some((v, i) => !v && i < n)) flags.hasUnreachable = true;

  // loop reachable from entry (matches the dispatcher's hasReachableLoop) +
  // ≥16 blocks ⇒ the production auto-dispatcher routes this CFG to the SSA path.
  const c2 = new Array(n).fill(0);
  let entryLoop = false;
  const st2: { node: number; idx: number }[] = [{ node: cfg.entryIndex, idx: 0 }];
  c2[cfg.entryIndex] = 1;
  while (st2.length && !entryLoop) {
    const top = st2[st2.length - 1];
    if (top.idx < succ[top.node].length) {
      const v = succ[top.node][top.idx++];
      if (c2[v] === 1) entryLoop = true;
      else if (c2[v] === 0) ((c2[v] = 1), st2.push({ node: v, idx: 0 }));
    } else ((c2[top.node] = 2), st2.pop());
  }
  if (n >= 16 && entryLoop) flags.hadLargeLoop = true;
}

// ── corpus runner ──────────────────────────────────────────────────────────
interface CorpusResult {
  checked: number;
  flags: ShapeFlags;
  firstFailure: string | null;
}

function runCorpus(
  left: Solver,
  right: Solver,
  count: number,
  baseSeed: number,
  // maxBlockVisits has DIFFERENT (intentional) semantics across the solvers: the
  // dense worklist counts block dequeues against it; the SSA solver has no
  // fixpoint iteration and ignores it in its main path (it only flows through to
  // the dense fallback for throw-edge/unreachable functions). So a tight budget
  // truncates them at different points. Perturb it only when comparing a solver
  // against ITSELF (same semantics); cross-solver byte-identity is asserted with
  // the budget unlimited (both fully converge).
  perturbBlockVisits = true,
): CorpusResult {
  const flags: ShapeFlags = {
    hasLoop: false,
    hasThrow: false,
    hasMayDef: false,
    hasShadow: false,
    hadLargeLoop: false,
    hasMultiPred: false,
    hasUnreachable: false,
    hadComputed: false,
    hadTruncated: false,
    hadNoFacts: false,
  };
  let firstFailure: string | null = null;
  let checked = 0;

  const check = (cfg: FunctionCfg, limits: ReachingDefsLimits | undefined, label: string): void => {
    const a = left(cfg, limits);
    const b = right(cfg, limits);
    const d = diffDefUse(a, b);
    checked++;
    if (a.status === 'computed') flags.hadComputed = true;
    if (a.status === 'truncated') flags.hadTruncated = true;
    if (a.status === 'no-facts') flags.hadNoFacts = true;
    if (d && !firstFailure) firstFailure = `${label}: ${d}`;
  };

  // canonical hard CFGs first (under several limit postures)
  for (const [i, cfg] of canonicalHardCfgs().entries()) {
    classify(cfg, flags);
    check(cfg, undefined, `canon[${i}]`);
    check(cfg, { maxFacts: 1 }, `canon[${i}]/maxFacts=1`);
    check(cfg, { maxFacts: 2 }, `canon[${i}]/maxFacts=2`);
    if (perturbBlockVisits) check(cfg, { maxBlockVisits: 2 }, `canon[${i}]/maxBlockVisits=2`);
  }

  // random corpus
  for (let i = 0; i < count; i++) {
    const seed = baseSeed + i;
    const cfg = genCfg(seed);
    classify(cfg, flags);
    check(cfg, undefined, `seed=${seed}`);
    // exercise truncation on ~1/4 of cases (small maxFacts) and the block-visit
    // ceiling on ~1/8 — both must match byte-for-byte (KTD6).
    if (i % 4 === 0) check(cfg, { maxFacts: 1 + (i % 3) }, `seed=${seed}/maxFacts`);
    if (perturbBlockVisits && i % 8 === 0) {
      check(cfg, { maxBlockVisits: 1 + (i % 4) }, `seed=${seed}/maxBlockVisits`);
    }
  }

  return { checked, flags, firstFailure };
}

const CORPUS_N = Number(process.env.GITNEXUS_RD_FUZZ_N ?? 1500);

describe('#2201 reaching-defs differential equivalence', () => {
  it('dense oracle is self-consistent and the comparator + generator are sound', () => {
    // U1 baseline: dense-vs-dense MUST be byte-identical (proves the harness).
    const r = runCorpus(computeReachingDefsDense, computeReachingDefsDense, CORPUS_N, 0x2201);
    expect(r.firstFailure).toBeNull();
    expect(r.checked).toBeGreaterThan(CORPUS_N);
  });

  it('the corpus exercises every divergence-prone shape (coverage guard)', () => {
    const r = runCorpus(computeReachingDefsDense, computeReachingDefsDense, CORPUS_N, 0x2201);
    const f = r.flags;
    expect(f.hasLoop, 'loops').toBe(true);
    expect(f.hasThrow, 'throw edges').toBe(true);
    expect(f.hasMayDef, 'may-defs').toBe(true);
    expect(f.hasShadow, 'shadowed bindings').toBe(true);
    expect(f.hasMultiPred, 'multi-pred joins').toBe(true);
    expect(f.hasUnreachable, 'unreachable blocks').toBe(true);
    expect(f.hadLargeLoop, '≥16-block looping CFGs (production SSA dispatch path)').toBe(true);
    expect(f.hadComputed, 'computed results').toBe(true);
    expect(f.hadTruncated, 'truncated results').toBe(true);
    expect(f.hadNoFacts, 'no-facts results').toBe(true);
  });

  it('is deterministic — a fixed seed yields a byte-identical corpus across runs', () => {
    const a = runCorpus(computeReachingDefsDense, computeReachingDefsDense, 200, 0xfeed);
    const b = runCorpus(computeReachingDefsDense, computeReachingDefsDense, 200, 0xfeed);
    expect(a.checked).toBe(b.checked);
    expect(a.flags).toEqual(b.flags);
  });

  it('the SPARSE solver is byte-identical to the dense oracle (#2201 gate)', () => {
    // The load-bearing equivalence gate: sparse vs dense across the full corpus,
    // budget unlimited so both fully converge. maxFacts truncation IS compared
    // (it must match byte-for-byte — KTD6); maxBlockVisits is not (the two count
    // different things on purpose — that contrast is the no-regression test).
    const r = runCorpus(
      computeReachingDefsSparse,
      computeReachingDefsDense,
      CORPUS_N,
      0x2201,
      /* perturbBlockVisits */ false,
    );
    expect(r.firstFailure).toBeNull();
    expect(r.flags.hadComputed && r.flags.hadTruncated).toBe(true);
  });

  it('PRODUCTION computeReachingDefs is byte-identical to the dense oracle', () => {
    // U1: computeReachingDefs delegates to dense (trivially green). U5 swaps it
    // to the sparse solver — this stays the production-entry gate.
    const r = runCorpus(
      computeReachingDefs,
      computeReachingDefsDense,
      CORPUS_N,
      0x5eed,
      /* perturbBlockVisits */ false,
    );
    expect(r.firstFailure).toBeNull();
  });

  it('sparse never regresses coverage under the production block-visit budget', () => {
    // Production posture: emit passes maxBlockVisits = blocks × 64. The contract
    // is one-directional — wherever the dense solver COMPUTES, the sparse solver
    // must also compute and produce identical facts (no lost REACHING_DEF
    // coverage). The reverse is allowed and desired: sparse may compute deep
    // nests the dense solver truncates (the #2201 ceiling-stops-firing win).
    let regressions = 0;
    let firstRegression: string | null = null;
    for (let i = 0; i < CORPUS_N; i++) {
      const cfg = genCfg(0xc0de + i);
      const budget = { maxBlockVisits: cfg.blocks.length * 64 };
      const dense = computeReachingDefsDense(cfg, budget);
      const sparse = computeReachingDefsSparse(cfg, budget);
      if (dense.status === 'computed') {
        const d = diffDefUse(dense, sparse);
        if (d) {
          regressions++;
          if (!firstRegression) firstRegression = `seed=${0xc0de + i}: ${d}`;
        }
      }
    }
    expect(firstRegression).toBeNull();
    expect(regressions).toBe(0);
  });
});

// Re-exported for U5 and future harness reuse.
export { genCfg, canonicalHardCfgs, diffDefUse, runCorpus, classify };
export type { Solver, ShapeFlags, CorpusResult };
