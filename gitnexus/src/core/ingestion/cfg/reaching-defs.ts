/**
 * Reaching definitions (#2082 M2 U3, SSA-sparse rewrite #2201) — per-function
 * intraprocedural may-reaching-definitions, plus the canonical intra-block
 * statement sweep that recovers statement-granular def→use facts from M1's
 * coalesced blocks WITHOUT re-splitting the CFG.
 *
 * ARCHITECTURE (#2201): the analysis is split into solver-INDEPENDENT stages
 * (shared by every path, so the byte-identical surface is maximal) and a
 * swappable IN-set computation:
 *   - {@link harvestStatementFacts} — per-block GEN/allDefs + def/use telemetry.
 *   - {@link buildAdjacency} — throw-aware predecessor/successor adjacency.
 *   - the IN-set computer — answers block-entry reaching-set queries. Two
 *     implementations: {@link computeInSetsSparse} (SSA — CHK dominators →
 *     Cytron dominance frontiers + φ-placement → stack renaming over a
 *     synthetic entry, walked SCC-condensed) and {@link computeInSetsDense}
 *     (the original GEN/KILL worklist). Production runs {@link
 *     computeInSetsAuto}, which picks the SSA solver for looping functions large
 *     enough to amortize construction (where it is asymptotically faster and
 *     never hits the dense ceiling) and the dense worklist everywhere else; the
 *     dense path also serves the throw-edge / unreachable-block cases the SSA
 *     path does not model. The two are held byte-identical by the equivalence
 *     fuzz — only set CONTENTS must match (the sweep sorts each use's keys
 *     before the maxFacts cutoff, so iteration order is irrelevant).
 *   - {@link sweepFacts} — statement sweep + sort + maxFacts truncation.
 *
 * PURE AND DETERMINISTIC (load-bearing contract):
 *  - Pure function of its inputs — no graph, no logger (warnings are the
 *    caller's job), importable outside the worker. The M3 taint engine calls
 *    this same function in-phase (facts are recomputed on demand, never
 *    retained run-wide — the persisted REACHING_DEF edges are a bounded
 *    projection, never the taint substrate).
 *  - Deterministic — predecessors merge in sorted block-index order,
 *    insertion-ordered Maps/Sets throughout, and the output fact array is
 *    explicitly sorted. Snapshot tests and content-derived edge ids rely on it.
 *
 * COMPLEXITY DISCIPLINE: def-sets are SHARED BY REFERENCE, never deep-copied —
 * a MUST def's kill is total per binding, so a transfer either aliases the
 * incoming set or replaces it; a MAY def (conditional context — see
 * StatementFacts.mayDefs) unions WITHOUT killing via a copy-on-extend.
 *
 * `limits.maxFacts` bounds materialization: facts are O(defs×uses) BY SPEC in
 * merge-heavy code (N branch-arm defs × N later uses = N² facts), and a
 * 2000-line function can spike 100k+ fact objects on the main thread. The
 * emit path passes DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION (emit.ts);
 * M3 passes its own large-but-finite limit and treats `status: 'truncated'`
 * as a per-function taint-coverage gap.
 */
import type { BindingEntry, FunctionCfg } from './types.js';

/** A statement-granular program point within one function's CFG. */
export interface ProgramPoint {
  readonly blockIndex: number;
  /** Statement index within the block's `statements` array. */
  readonly stmtIndex: number;
  readonly line: number;
}

/**
 * Canonical `block:stmt` string key for a program point. Colon-separated to
 * match the codebase's `blockIndex:stmtIndex` id conventions. Shared by the
 * taint propagation engine (dedup/state keys) and the taint emit path
 * (persisted edge-id material) so the two never drift.
 */
export function pointKey(p: ProgramPoint): string {
  return `${p.blockIndex}:${p.stmtIndex}`;
}

/** One def→use fact: the definition at `def` reaches the use at `use`. */
export interface DefUseFact {
  /** Index into {@link FunctionDefUse.bindings}. */
  readonly bindingIdx: number;
  readonly def: ProgramPoint;
  readonly use: ProgramPoint;
}

export interface ReachingDefsLimits {
  /**
   * Maximum number of facts to materialize; the sweep stops early and reports
   * `status: 'truncated'`. `undefined`/0 ⇒ unlimited.
   */
  readonly maxFacts?: number;
  /**
   * Adversarial-only safety bound on the DENSE worklist's iteration.
   *
   * The dense GEN/KILL solver reads this as a ceiling on total block dequeues:
   * iterative reaching-defs on a reducible CFG converges in O(loop-nesting-depth)
   * passes, but a pathologically deep loop nest drives the visit total — and thus
   * the solver — to O(blocks²), seconds + GB of heap (`maxFacts` does not help:
   * fact count stays linear). Exceeding the budget means the fixpoint has NOT
   * converged, so any facts would be unsound — the dense solver bails to a sound
   * empty `status: 'truncated'` (like the `overflow` guard).
   *
   * The SSA solver (#2201) has NO fixpoint iteration — it answers reaching
   * queries from the def-use graph in one pass — so it always converges and this
   * budget never trips it. The production dispatcher ({@link computeInSetsAuto})
   * routes the deep nests that would breach the dense ceiling to the SSA solver,
   * which computes their full facts: the ceiling that fired on the dense worklist
   * effectively never fires on real code (#2201 acceptance). The budget is still
   * honored on the dense fallback path (small / loop-free functions, and the
   * throw-edge / unreachable-block cases the SSA path does not model).
   *
   * `undefined`/0 ⇒ unlimited (the default for direct callers; the emit path sets
   * a per-function budget).
   */
  readonly maxBlockVisits?: number;
}

export interface FunctionDefUse {
  /**
   * `computed`  — full facts.
   * `no-facts`  — the CFG carries no statement facts (hand-built or pre-M2
   *               side channel); empty facts, NOT an error.
   * `truncated` — `limits.maxFacts` hit; `facts` is a deterministic prefix.
   * `overflow`  — a block's statement count breaches the def-key stride; no
   *               facts at all (computing any would risk key aliasing —
   *               wrong-block facts are strictly worse than none). Distinct
   *               from `truncated` so the caller's diagnostic doesn't
   *               misname it as the fact-materialization limit.
   */
  readonly status: 'computed' | 'no-facts' | 'truncated' | 'overflow';
  /** Pass-through of the CFG's binding table (empty for `no-facts`). */
  readonly bindings: readonly BindingEntry[];
  /** Sorted by (def block, def stmt, use block, use stmt, binding). */
  readonly facts: readonly DefUseFact[];
  /** Total def / use sites seen (telemetry; independent of truncation). */
  readonly defCount: number;
  readonly useCount: number;
}

/**
 * def-site key: packs (blockIndex, stmtIndex) into one number. The stride is
 * a per-BLOCK statement bound, and `maxFunctionLines` caps LINES, not
 * statements — a minified one-line function coalesces arbitrarily many
 * statements into one block, so an overflow would silently alias
 * (block b, stmt STRIDE+k) with (block b+1, stmt k) and fabricate wrong-block
 * facts. computeReachingDefs therefore range-checks up front and bails to a
 * sound empty `overflow` result instead of ever letting a key alias.
 * 2^21 statements per block × blocks ≤ 2^32 stays inside Number's 2^53.
 */
const STMT_STRIDE = 1 << 21;
const defKey = (blockIndex: number, stmtIndex: number): number =>
  blockIndex * STMT_STRIDE + stmtIndex;

type DefSet = Set<number>;
/** bindingIdx → def-site keys reaching this program point. */
type Lattice = Map<number, DefSet>;

const EMPTY_LATTICE: Lattice = new Map();

/** A block's GEN entry for one binding: the genned set + whether it kills. */
interface GenEntry {
  set: DefSet;
  kills: boolean;
}

/** Solver-independent per-block facts (shared by both IN-set computers). */
interface Harvest {
  /** gen[b]: bindingIdx → { set, kills }. A MUST def kills; a MAY def adds. */
  readonly gen: readonly (Map<number, GenEntry> | null)[];
  /** allDefsGen[b]: bindingIdx → EVERY def-site key in the block (throw edges). */
  readonly allDefsGen: readonly (Lattice | null)[];
  readonly defLine: ReadonlyMap<number, number>;
  readonly defCount: number;
  readonly useCount: number;
}

/** Throw-aware adjacency (shared by both IN-set computers). */
interface Adjacency {
  readonly preds: readonly { from: number; viaThrow: boolean }[][];
  readonly succs: readonly number[][];
  /** Handlers whose IN depends on a block's IN (throw edges). */
  readonly throwSuccs: readonly number[][];
}

/**
 * Block-entry reaching-set accessor: the set of def-site keys of `binding`
 * reaching `blockIndex`'s entry, or undefined when none reach. Both solvers
 * expose their result through this accessor so the sweep is solver-agnostic;
 * the dense oracle backs it with precomputed per-block lattices, the sparse
 * solver computes it lazily from the SSA def-use graph. Because {@link
 * sweepFacts} sorts each use's reaching keys before the maxFacts cutoff, only
 * the set CONTENTS need to match across solvers — not iteration order.
 */
type ReachingAt = (blockIndex: number, binding: number) => DefSet | undefined;

/**
 * The swappable stage: a block-entry reaching-set accessor, or a non-
 * convergence signal (the work budget exceeded ⇒ sound empty `truncated`).
 */
type InSetsResult = { converged: true; reachingAt: ReachingAt } | { converged: false };

type InSetsComputer = (
  cfg: FunctionCfg,
  n: number,
  h: Harvest,
  adj: Adjacency,
  limits: ReachingDefsLimits | undefined,
) => InSetsResult;

/**
 * Compute reaching definitions for one function. See the module doc for the
 * purity/determinism/sharing contract.
 *
 * This is the production entry point. As of #2201 it auto-dispatches via
 * {@link computeInSetsAuto} — the SSA-sparse solver ({@link computeInSetsSparse})
 * for looping functions large enough to amortize construction, the dense
 * GEN/KILL worklist ({@link computeInSetsDense}) everywhere else (and for the
 * throw-edge / unreachable-block functions the SSA path does not model). The two
 * solvers are held byte-identical by the equivalence fuzz (status, bindings,
 * sorted facts, def/use telemetry), so the dispatch is a pure performance
 * heuristic; the dense solver doubles as that differential oracle.
 */
export function computeReachingDefs(cfg: FunctionCfg, limits?: ReachingDefsLimits): FunctionDefUse {
  // #2201: production auto-selects the solver per function (see
  // {@link computeInSetsAuto}) — the SSA solver where it pays off (looping
  // functions large enough to amortize construction, incl. the deep nests the
  // dense ceiling used to truncate), the dense worklist everywhere else (small
  // or loop-free functions, where it is faster). Both are held byte-identical
  // by the equivalence fuzz, so the choice is a pure performance heuristic.
  return solveReachingDefs(cfg, limits, computeInSetsAuto);
}

/**
 * Dense GEN/KILL monotone worklist — the original (#2082 M2) reaching-defs
 * solver. As of #2201 it plays two roles: (1) the production dispatcher
 * ({@link computeInSetsAuto}) routes small / loop-free functions, and the
 * throw-edge / unreachable-block functions the SSA path does not model, to this
 * dense solver; (2) it is the differential equivalence ORACLE the fuzz checks
 * the SSA path against. Keep it behavior-frozen — it is the ground truth.
 *
 * @internal exported for the equivalence fuzz harness (direct dense-vs-sparse
 * comparison); the bench drives the production {@link computeReachingDefs}.
 */
export function computeReachingDefsDense(
  cfg: FunctionCfg,
  limits?: ReachingDefsLimits,
): FunctionDefUse {
  return solveReachingDefs(cfg, limits, computeInSetsDense);
}

/**
 * SSA-sparse reaching-defs (#2201) — exposed directly so the equivalence fuzz
 * can drive the SSA solver on every eligible CFG (bypassing the production
 * size/loop dispatch heuristic in {@link computeInSetsAuto}) and assert
 * byte-identity against the dense oracle. See {@link computeInSetsSparse} for
 * the algorithm and byte-identical contract.
 *
 * @internal exported only for the equivalence fuzz harness.
 */
export function computeReachingDefsSparse(
  cfg: FunctionCfg,
  limits?: ReachingDefsLimits,
): FunctionDefUse {
  return solveReachingDefs(cfg, limits, computeInSetsSparse);
}

/**
 * Shared orchestrator: the no-facts / overflow guards, the harvest, the
 * adjacency build, the swappable IN-set computation, and the statement sweep.
 * Only `computeInSets` differs between the production (sparse) and oracle
 * (dense) paths — everything else is identical, which is what makes the two
 * byte-identical by construction.
 */
function solveReachingDefs(
  cfg: FunctionCfg,
  limits: ReachingDefsLimits | undefined,
  computeInSets: InSetsComputer,
): FunctionDefUse {
  if (!cfg.bindings) {
    return { status: 'no-facts', bindings: [], facts: [], defCount: 0, useCount: 0 };
  }

  const blocks = cfg.blocks;
  const n = blocks.length;

  // Key-aliasing guard (see STMT_STRIDE): a block with ≥ STRIDE statements
  // cannot be keyed without aliasing into the next block's def sites, which
  // would fabricate wrong-block facts — strictly worse than producing none.
  // Bail to a sound empty `overflow` result (the emit path warns distinctly).
  for (const b of blocks) {
    if ((b.statements?.length ?? 0) >= STMT_STRIDE) {
      return { status: 'overflow', bindings: cfg.bindings, facts: [], defCount: 0, useCount: 0 };
    }
  }

  const h = harvestStatementFacts(blocks, n);
  const adj = buildAdjacency(cfg, n);
  const solved = computeInSets(cfg, n, h, adj, limits);
  if (!solved.converged) {
    // Did NOT converge within the budget — the in-sets are not at the fixpoint,
    // so any facts would be unsound. Bail to a sound empty `truncated` result
    // (a coverage gap, not an error), carrying the def/use telemetry gathered.
    return {
      status: 'truncated',
      bindings: cfg.bindings,
      facts: [],
      defCount: h.defCount,
      useCount: h.useCount,
    };
  }

  const maxFacts = limits?.maxFacts && limits.maxFacts > 0 ? limits.maxFacts : Infinity;
  const { facts, truncated } = sweepFacts(blocks, solved.reachingAt, h.defLine, maxFacts);

  return {
    status: truncated ? 'truncated' : 'computed',
    bindings: cfg.bindings,
    facts,
    defCount: h.defCount,
    useCount: h.useCount,
  };
}

/**
 * Per-block GEN + def/use telemetry. gen[b]: bindingIdx → { set, kills }. A
 * MUST def resets the accumulated set (kill is total); a MAY def (conditionally-
 * evaluated context — see StatementFacts.mayDefs) only ADDS: the binding's
 * incoming defs survive, so the transfer is out[x] = kills ? set : in[x] ∪ set.
 * allDefsGen[b] is what a throw edge delivers to its handler: an exception can
 * fire between any two statements, so every intermediate def may be the live one
 * at the handler — IN∪OUT alone misses defs overwritten later in the same
 * coalesced block.
 */
function harvestStatementFacts(blocks: FunctionCfg['blocks'], n: number): Harvest {
  const gen: (Map<number, GenEntry> | null)[] = new Array(n).fill(null);
  const allDefsGen: (Lattice | null)[] = new Array(n).fill(null);
  const defLine = new Map<number, number>(); // defKey → source line
  let defCount = 0;
  let useCount = 0;
  for (const b of blocks) {
    const stmts = b.statements;
    if (!stmts || stmts.length === 0) continue;
    let g: Map<number, GenEntry> | null = null;
    let all: Lattice | null = null;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      useCount += s.uses.length;
      const key = defKey(b.index, i);
      const record = (d: number, kills: boolean): void => {
        defCount += 1;
        defLine.set(key, s.line);
        if (!g) g = new Map();
        const entry = g.get(d);
        if (kills || !entry) {
          g.set(d, { set: new Set([key]), kills: kills || (entry?.kills ?? false) });
        } else {
          entry.set.add(key); // may-def accumulates; never clears
        }
        if (!all) all = new Map();
        const allSet = all.get(d);
        if (allSet) allSet.add(key);
        else all.set(d, new Set([key]));
      };
      if (s.mayDefs) for (const d of s.mayDefs) record(d, false);
      for (const d of s.defs) record(d, true);
    }
    gen[b.index] = g;
    allDefsGen[b.index] = all;
  }
  return { gen, allDefsGen, defLine, defCount, useCount };
}

/**
 * Throw-aware predecessor/successor adjacency, sorted for deterministic merges.
 * A `throw` edge contributes IN(from) ∪ allDefs(from) to its handler, not OUT:
 * an exception may fire BEFORE the block's defs complete (the seed def in
 * `let x = seed(); try { x = risky(); } catch { sink(x) }` must reach the sink)
 * AND between any two defs of a multi-def coalesced block. Sound over-
 * approximation; monotone, so the fixpoint absorbs it. See mergePreds.
 */
function buildAdjacency(cfg: FunctionCfg, n: number): Adjacency {
  const preds: { from: number; viaThrow: boolean }[][] = Array.from({ length: n }, () => []);
  const succs: number[][] = Array.from({ length: n }, () => []);
  // Handlers whose IN depends on this block's IN (throw edges) — requeued on
  // IN change, since a genned binding can absorb IN growth without changing
  // OUT, which would otherwise leave the handler stale.
  const throwSuccs: number[][] = Array.from({ length: n }, () => []);
  for (const e of cfg.edges) {
    // Optional-chained pushes drop out-of-range endpoints defensively — the
    // emit path validates via isEmitSafeCfg, but this pure function also runs
    // on hand-built CFGs.
    succs[e.from]?.push(e.to);
    preds[e.to]?.push({ from: e.from, viaThrow: e.kind === 'throw' });
    if (e.kind === 'throw') throwSuccs[e.from]?.push(e.to);
  }
  for (const list of preds) {
    list.sort((a, b) => a.from - b.from || Number(a.viaThrow) - Number(b.viaThrow));
    // duplicate (from, throw+non-throw) pairs both survive — the throw leg
    // adds IN(from); the merge dedups set-wise.
  }
  for (const list of succs) list.sort((a, b) => a - b);
  return { preds, succs, throwSuccs };
}

/**
 * DENSE IN-set computer — the original monotone GEN/KILL worklist. Iterates in
 * reverse post-order, seeded with every block (unreachable blocks keep ⊥ IN —
 * correct, their defs reach nothing). Convergence: sets grow monotonically
 * within the finite def-site universe ⇒ ≤ loop-depth+1 passes in practice.
 *
 * WTO / loop-aware iteration (Bourdoncle 1993) was evaluated as a fix for the
 * O(blocks²) deep-loop-nest blow-up and REJECTED (#2195): on the dense-loop
 * benchmark a faithful weak-topological-order solver was 104/104 byte-identical
 * but 0% faster — the cost is inherent to dense-set propagation + lattice
 * merges, not visitation order. The asymptotic fix shipped in #2201: the
 * SSA-sparse solver ({@link computeInSetsSparse}). This dense version is retained
 * only as the differential equivalence oracle the fuzz checks SSA against.
 *
 * @internal
 */
function computeInSetsDense(
  cfg: FunctionCfg,
  n: number,
  h: Harvest,
  adj: Adjacency,
  limits: ReachingDefsLimits | undefined,
): InSetsResult {
  const { gen, allDefsGen } = h;
  const { preds, succs, throwSuccs } = adj;
  const order = reversePostOrder(cfg.entryIndex, succs, n);

  const inSets: Lattice[] = new Array(n).fill(EMPTY_LATTICE);
  const outSets: Lattice[] = new Array(n).fill(EMPTY_LATTICE);

  const inWorklist = new Array(n).fill(true);
  let pending = n;
  const maxBlockVisits =
    limits?.maxBlockVisits && limits.maxBlockVisits > 0 ? limits.maxBlockVisits : Infinity;
  let blockVisits = 0;
  while (pending > 0) {
    for (const b of order) {
      if (!inWorklist[b]) continue;
      inWorklist[b] = false;
      pending -= 1;
      if (++blockVisits > maxBlockVisits) return { converged: false };

      const p = preds[b];
      const inB: Lattice =
        p.length === 0
          ? EMPTY_LATTICE
          : p.length === 1 && !p[0].viaThrow
            ? outSets[p[0].from] // alias — zero allocation on straight-line chains
            : mergePreds(p, inSets, outSets, allDefsGen);
      const inChanged = !latticeEquals(inSets[b], inB);
      inSets[b] = inB;

      const g = gen[b];
      // OUT = overlay(IN): a KILLING gen entry replaces the binding's set; a
      // may-def-only entry unions with the incoming set (never kills). When
      // nothing is genned, OUT aliases IN outright.
      let outB: Lattice;
      if (!g) {
        outB = inB;
      } else {
        outB = new Map(inB); // copies REFERENCES, never set contents
        for (const [bindingIdx, entry] of g) {
          if (entry.kills) {
            outB.set(bindingIdx, entry.set);
          } else {
            const incoming = inB.get(bindingIdx);
            outB.set(bindingIdx, incoming ? unionSets(incoming, entry.set) : entry.set);
          }
        }
      }

      const requeue = (s: number): void => {
        if (!inWorklist[s]) {
          inWorklist[s] = true;
          pending += 1;
        }
      };
      if (!latticeEquals(outSets[b], outB)) {
        outSets[b] = outB;
        for (const s of succs[b]) requeue(s);
      }
      if (inChanged) for (const s of throwSuccs[b]) requeue(s);
    }
  }

  return { converged: true, reachingAt: (blockIndex, binding) => inSets[blockIndex]?.get(binding) };
}

/**
 * SPARSE IN-set computer (#2201) — the production solver. Instead of the dense
 * GEN/KILL worklist's per-block lattice fixpoint, it builds pruned SSA for the
 * function (Cooper-Harvey-Kennedy dominators → Cytron dominance frontiers and
 * φ-placement → stack-based renaming) and answers block-entry reaching-def
 * queries by walking the SSA def-use graph. φ-nodes statically capture loop
 * merges, so a use's reaching set is recovered without iterating the loop
 * (depth-independent), and pass-through blocks carry the dominating definition
 * via the rename stack rather than re-materializing a dense lattice at every
 * block — the two effects that make it faster than the dense solver on the
 * deep-nest and dense-bindings pathologies.
 *
 * BYTE-IDENTICAL CONTRACT: it computes the same may-reaching-definition SET at
 * each block entry as {@link computeInSetsDense}. Order does not matter — {@link
 * sweepFacts} sorts each use's reaching keys before the maxFacts cutoff (#2201
 * KTD6) — so only set CONTENTS must match; the equivalence fuzz holds the line.
 *
 * SCOPE (KTD4): the SSA path covers fully-reachable CFGs with kill/may-def
 * transfers, reducible AND irreducible (CHK + Cytron are correct on irreducible
 * graphs). It does NOT model throw edges' IN∪allDefs handler semantics or
 * propagation among unreachable blocks; functions with either are routed to the
 * dense oracle — byte-identical and correct, just not asymptotically faster.
 * These are not the perf pathologies (deep nests / dense-bindings are
 * throw-free and fully reachable), so the win lands where it matters.
 *
 * No fixpoint iteration ⇒ the solve always converges in O(program); the
 * `maxBlockVisits` ceiling that fired on the dense worklist's deep nests never
 * fires here (#2201 acceptance). The bound is honored only on the dense
 * fallback path.
 *
 * @internal
 */
function computeInSetsSparse(
  cfg: FunctionCfg,
  n: number,
  h: Harvest,
  adj: Adjacency,
  limits: ReachingDefsLimits | undefined,
): InSetsResult {
  const nBindings = cfg.bindings?.length ?? 0;
  if (nBindings === 0) return { converged: true, reachingAt: () => undefined };

  const { gen } = h;
  const { preds, succs, throwSuccs } = adj;
  const entry = cfg.entryIndex;

  // Gate to the dense oracle for the two shapes the SSA path does not model.
  for (const list of throwSuccs) if (list.length) return computeInSetsDense(cfg, n, h, adj, limits);
  const reachable = new Array<boolean>(n).fill(false);
  {
    const q = [entry];
    reachable[entry] = true;
    while (q.length) {
      const x = q.pop()!;
      for (const s of succs[x]) if (!reachable[s]) ((reachable[s] = true), q.push(s));
    }
  }
  for (let b = 0; b < n; b++) if (!reachable[b]) return computeInSetsDense(cfg, n, h, adj, limits);

  // Synthetic pre-entry block (#2201): textbook SSA construction assumes the
  // entry has no predecessors. A loop back-edge into the entry — or a self-loop
  // on it — makes the entry a merge that needs a φ, and the dominance-frontier
  // walk degenerates when idom[entry] === entry (it never lands the entry in its
  // own frontier). A virtual start node S → entry (S itself has no preds)
  // restores the invariant: idom[entry] = S, the entry joins {start ⊔
  // back-edges}, and the implicit start operand contributes ⊥ (an empty rename
  // stack). S carries no statements, gen, or uses and is never queried.
  const S = n;
  const nx = n + 1;
  const succsX: number[][] = new Array(nx);
  for (let b = 0; b < n; b++) succsX[b] = succs[b] as number[];
  succsX[S] = [entry];
  const dPredsX: number[][] = new Array(nx);
  for (let b = 0; b < n; b++) {
    const set = new Set<number>();
    for (const p of preds[b]) set.add(p.from);
    if (b === entry) set.add(S);
    dPredsX[b] = [...set].sort((a, c) => a - c);
  }
  dPredsX[S] = [];

  // ── dominators (Cooper-Harvey-Kennedy; correct on irreducible CFGs) ──
  const rpo = reversePostOrder(S, succsX, nx); // rooted at the synthetic entry
  const rpoIdx = new Array<number>(nx);
  rpo.forEach((b, i) => (rpoIdx[b] = i));
  const idom = new Array<number>(nx).fill(-1);
  idom[S] = S;
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while (rpoIdx[a] > rpoIdx[b]) a = idom[a];
      while (rpoIdx[b] > rpoIdx[a]) b = idom[b];
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of rpo) {
      if (b === S) continue;
      let nd = -1;
      for (const p of dPredsX[b]) if (idom[p] !== -1) nd = nd === -1 ? p : intersect(nd, p);
      if (nd !== -1 && idom[b] !== nd) {
        idom[b] = nd;
        changed = true;
      }
    }
  }

  // ── dominance frontiers (Cytron) ──
  const df: Set<number>[] = Array.from({ length: nx }, () => new Set<number>());
  for (let b = 0; b < nx; b++) {
    const dp = dPredsX[b];
    if (dp.length < 2) continue;
    for (const p of dp) {
      let runner = p;
      while (runner !== idom[b] && runner !== -1) {
        df[runner].add(b);
        runner = idom[runner];
      }
    }
  }

  // ── per-binding def blocks (must- or may-def ⇒ block transfer touches v) ──
  const defBlocks: number[][] = Array.from({ length: nBindings }, () => []);
  for (let b = 0; b < n; b++) {
    const g = gen[b];
    if (g) for (const v of g.keys()) defBlocks[v].push(b);
  }

  // ── value-graph nodes: leaves carry def-site keys; internal nodes (φ /
  //    may-def union) carry operand node ids. reachingSet(node) = union of all
  //    leaf keys reachable through operands (computed once, cycle-safe, below).
  const nodeKeys: (DefSet | null)[] = [];
  const nodeOps: number[][] = [];
  const newLeaf = (keys: DefSet): number => (
    nodeKeys.push(keys),
    nodeOps.push([]),
    nodeKeys.length - 1
  );
  const newInternal = (): number => (nodeKeys.push(null), nodeOps.push([]), nodeKeys.length - 1);

  // ── φ-placement: φ for v at the iterated dominance frontier of v's defs ──
  const phiNode: (Map<number, number> | null)[] = new Array(nx).fill(null);
  for (let v = 0; v < nBindings; v++) {
    const dB = defBlocks[v];
    if (dB.length === 0) continue;
    const placed = new Set<number>();
    const inWork = new Set<number>(dB);
    const work = [...dB];
    while (work.length) {
      const x = work.pop()!;
      for (const y of df[x]) {
        if (placed.has(y)) continue;
        placed.add(y);
        let m = phiNode[y];
        if (!m) phiNode[y] = m = new Map();
        m.set(v, newInternal());
        if (!inWork.has(y)) {
          inWork.add(y);
          work.push(y);
        }
      }
    }
  }

  // ── renaming (iterative dominator-tree DFS, per-binding value stacks) ──
  const domChildren: number[][] = Array.from({ length: nx }, () => []);
  for (let b = 0; b < nx; b++) if (b !== S && idom[b] !== -1) domChildren[idom[b]].push(b);
  for (const list of domChildren) list.sort((a, b) => a - b);

  const stacks: number[][] = Array.from({ length: nBindings }, () => []);
  const entryValue: (Map<number, number> | null)[] = new Array(nx).fill(null);

  const enterBlock = (b: number): number[] => {
    const pushed: number[] = [];
    const pm = phiNode[b];
    if (pm)
      for (const [v, node] of pm) {
        stacks[v].push(node);
        pushed.push(v);
      }
    // record block-entry (IN) value for each binding USED here — after φ push,
    // before this block's own gen (the sweep applies intra-block defs itself).
    // The synthetic entry S has no block ⇒ no statements/gen/uses.
    const stmts = cfg.blocks[b]?.statements;
    if (stmts) {
      let ev: Map<number, number> | null = null;
      for (const s of stmts)
        for (const u of s.uses) {
          const st = stacks[u];
          if (st.length) {
            if (!ev) ev = new Map();
            ev.set(u, st[st.length - 1]);
          }
        }
      entryValue[b] = ev;
    }
    // apply block gen ⇒ OUT values that flow to successors
    const g = gen[b];
    if (g)
      for (const [v, ge] of g) {
        const st = stacks[v];
        let node: number;
        if (ge.kills) {
          node = newLeaf(ge.set);
        } else {
          node = newInternal();
          if (st.length) nodeOps[node].push(st[st.length - 1]); // prior reaching (may-def keeps it)
          nodeOps[node].push(newLeaf(ge.set));
        }
        st.push(node);
        pushed.push(v);
      }
    // fill successor φ operands with this block's current OUT for each φ binding
    for (const s of succsX[b]) {
      const sm = phiNode[s];
      if (!sm) continue;
      for (const [v, phi] of sm) {
        const st = stacks[v];
        if (st.length) nodeOps[phi].push(st[st.length - 1]);
      }
    }
    return pushed;
  };

  const frames: { b: number; ci: number; pushed: number[] }[] = [
    { b: S, ci: 0, pushed: enterBlock(S) },
  ];
  while (frames.length) {
    const f = frames[frames.length - 1];
    const kids = domChildren[f.b];
    if (f.ci < kids.length) {
      const c = kids[f.ci++];
      frames.push({ b: c, ci: 0, pushed: enterBlock(c) });
    } else {
      for (const v of f.pushed) stacks[v].pop();
      frames.pop();
    }
  }

  // ── reaching sets per node via SCC condensation (cycle-safe union) ──
  // Tarjan emits SCCs in reverse topological order, so an SCC's operand SCCs
  // are numbered before it ⇒ a single forward pass over SCCs resolves unions.
  const N = nodeKeys.length;
  const sccOf = new Array<number>(N).fill(-1);
  const sccMembers: number[][] = [];
  const index = new Array<number>(N).fill(-1);
  const low = new Array<number>(N).fill(0);
  const onStk = new Array<boolean>(N).fill(false);
  const tarjanStk: number[] = [];
  let counter = 0;
  for (let start = 0; start < N; start++) {
    if (index[start] !== -1) continue;
    const work: { node: number; oi: number }[] = [{ node: start, oi: 0 }];
    index[start] = low[start] = counter++;
    tarjanStk.push(start);
    onStk[start] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const ops = nodeOps[top.node];
      if (top.oi < ops.length) {
        const w = ops[top.oi++];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          tarjanStk.push(w);
          onStk[w] = true;
          work.push({ node: w, oi: 0 });
        } else if (onStk[w] && index[w] < low[top.node]) {
          low[top.node] = index[w];
        }
      } else {
        if (low[top.node] === index[top.node]) {
          const members: number[] = [];
          let w: number;
          do {
            w = tarjanStk.pop()!;
            onStk[w] = false;
            sccOf[w] = sccMembers.length;
            members.push(w);
          } while (w !== top.node);
          sccMembers.push(members);
        }
        work.pop();
        if (work.length) {
          const par = work[work.length - 1].node;
          if (low[top.node] < low[par]) low[par] = low[top.node];
        }
      }
    }
  }
  const reachByScc: DefSet[] = new Array(sccMembers.length);
  for (let s = 0; s < sccMembers.length; s++) {
    const set: DefSet = new Set();
    for (const node of sccMembers[s]) {
      const keys = nodeKeys[node];
      if (keys) for (const k of keys) set.add(k);
      for (const w of nodeOps[node]) {
        const ws = sccOf[w];
        if (ws !== s) for (const k of reachByScc[ws]) set.add(k);
      }
    }
    reachByScc[s] = set;
  }

  return {
    converged: true,
    reachingAt: (blockIndex, binding) => {
      const node = entryValue[blockIndex]?.get(binding);
      if (node === undefined) return undefined;
      const set = reachByScc[sccOf[node]];
      return set.size ? set : undefined;
    },
  };
}

/**
 * Minimum block count below which SSA construction (dominators + dominance
 * frontiers + φ-placement + renaming + SCC) does not amortize over the dense
 * worklist's single-pass aliasing. Calibrated empirically (~14-block crossover
 * for loop-heavy functions; 16 leaves headroom); the dense-bindings
 * `rd_scaling_budget` gate in bench/cfg/baselines.json catches a regression if
 * this is mistuned. Paired with a reachable-loop check — loop-free functions
 * always take the cheaper dense path regardless of size.
 */
const SSA_MIN_BLOCKS = 16;

/**
 * True iff a cycle is reachable from `entry` (the CFG has a loop). Iterative DFS
 * with a gray/black coloring; a gray successor is a back-edge. O(V+E).
 */
function hasReachableLoop(entry: number, succs: readonly number[][], n: number): boolean {
  const color = new Uint8Array(n); // 0 white, 1 gray, 2 black
  const stack: { node: number; i: number }[] = [{ node: entry, i: 0 }];
  color[entry] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const ss = succs[top.node];
    if (top.i < ss.length) {
      const next = ss[top.i++];
      if (color[next] === 1) return true;
      if (color[next] === 0) {
        color[next] = 1;
        stack.push({ node: next, i: 0 });
      }
    } else {
      color[top.node] = 2;
      stack.pop();
    }
  }
  return false;
}

/**
 * Production solver dispatcher (#2201). The SSA solver beats the dense worklist
 * only when there is enough work to amortize SSA construction — a loop (so the
 * dense fixpoint pays the loop-depth pass multiplier, or truncates at the
 * ceiling) AND a non-trivial block count. Small or loop-free functions, which
 * dense solves in one or two cheap aliasing passes, stay on the dense path.
 * Because the two solvers are byte-identical (held by the equivalence fuzz),
 * this is a pure performance heuristic with no effect on results.
 *
 * @internal
 */
function computeInSetsAuto(
  cfg: FunctionCfg,
  n: number,
  h: Harvest,
  adj: Adjacency,
  limits: ReachingDefsLimits | undefined,
): InSetsResult {
  if (n >= SSA_MIN_BLOCKS && hasReachableLoop(cfg.entryIndex, adj.succs, n)) {
    return computeInSetsSparse(cfg, n, h, adj, limits);
  }
  return computeInSetsDense(cfg, n, h, adj, limits);
}

/**
 * Statement sweep — recover statement-granular def→use facts from the per-block
 * entry reaching lattices, sort them, and apply the maxFacts truncation. SHARED
 * by both solvers: the truncated SUBSET depends on the pre-sort emission order
 * here (block index, then statement index, then use order, then the reaching
 * set's INSERTION order), so producing identical inSets — insertion order
 * included — is what makes a truncated result byte-identical across solvers.
 */
function sweepFacts(
  blocks: FunctionCfg['blocks'],
  reachingAt: ReachingAt,
  defLine: ReadonlyMap<number, number>,
  maxFacts: number,
): { facts: DefUseFact[]; truncated: boolean } {
  const facts: DefUseFact[] = [];
  let truncated = false;

  outer: for (const b of blocks) {
    const stmts = b.statements;
    if (!stmts || stmts.length === 0) continue;
    // Sparse intra-block overlay: only the bindings REDEFINED within this block
    // so far. A use's reaching set is the overlay's override if present, else
    // the block-entry reaching set (reachingAt). This never materializes the
    // full block lattice — the dense O(live-vars) per-block copy the sparse
    // solver exists to avoid.
    const overlay = new Map<number, DefSet>();
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      // A use's binding that the SAME statement also defines could be a
      // read-then-write (`x += 1` — sees prior defs) OR a write-then-read
      // (`if ((m = re.exec(s)) && m[1])` — sees the same-statement def).
      // StatementFacts carries no intra-statement order, so emit BOTH: prior
      // defs ∪ the same-statement def. Sound over-approximation — the extra
      // self-fact on compound assignments is harmless; missing the
      // assign-and-test def→use (the most common JS idiom) would be a taint
      // false negative. May-defs join the self-key set the same way.
      const sameStmtDefs =
        s.defs.length > 0 || s.mayDefs?.length ? new Set([...s.defs, ...(s.mayDefs ?? [])]) : null;
      for (const u of s.uses) {
        const reaching = overlay.get(u) ?? reachingAt(b.index, u);
        const selfKey = sameStmtDefs?.has(u) ? defKey(b.index, i) : undefined;
        if (!reaching && selfKey === undefined) continue;
        const keys =
          selfKey !== undefined && !reaching?.has(selfKey)
            ? [...(reaching ?? []), selfKey]
            : [...(reaching ?? [])];
        // Canonical emission order (#2201 KTD6): sort each use's reaching
        // def-sites by defKey (= def block, then def stmt) BEFORE the maxFacts
        // cutoff. The full (untruncated) fact array is re-sorted identically at
        // the end, so this is a no-op there; its purpose is to make the
        // TRUNCATED subset schedule-independent — the reaching SET's insertion
        // order is fixpoint-evaluation-order-dependent for loop-carried
        // bindings (dense RPO vs sparse change-driven seed different keys
        // first), so a pre-sort cutoff is what keeps the two solvers'
        // truncated results byte-identical.
        keys.sort((a, b) => a - b);
        for (const key of keys) {
          if (facts.length >= maxFacts) {
            truncated = true;
            break outer;
          }
          const defBlock = Math.floor(key / STMT_STRIDE);
          const defStmt = key % STMT_STRIDE;
          facts.push({
            bindingIdx: u,
            def: { blockIndex: defBlock, stmtIndex: defStmt, line: defLine.get(key) ?? s.line },
            use: { blockIndex: b.index, stmtIndex: i, line: s.line },
          });
        }
      }
      if (s.mayDefs?.length) {
        // Gen WITHOUT kill: the conditional def joins the binding's set.
        const key = defKey(b.index, i);
        for (const d of s.mayDefs) {
          const prior = overlay.get(d) ?? reachingAt(b.index, d);
          overlay.set(d, prior ? unionSets(prior, new Set([key])) : new Set([key]));
        }
      }
      if (s.defs.length > 0) {
        for (const d of s.defs) overlay.set(d, new Set([defKey(b.index, i)])); // kill + gen
      }
    }
  }

  facts.sort(
    (a, b) =>
      a.def.blockIndex - b.def.blockIndex ||
      a.def.stmtIndex - b.def.stmtIndex ||
      a.use.blockIndex - b.use.blockIndex ||
      a.use.stmtIndex - b.use.stmtIndex ||
      a.bindingIdx - b.bindingIdx,
  );

  return { facts, truncated };
}

/** RPO over blocks reachable from `entry`; unreachable blocks appended by index. */
function reversePostOrder(entry: number, succs: readonly number[][], n: number): number[] {
  const visited = new Array<boolean>(n).fill(false);
  const post: number[] = [];
  // Iterative DFS with an explicit phase stack (children pushed in reverse so
  // they pop in sorted order — determinism).
  const stack: { node: number; childIdx: number }[] = [{ node: entry, childIdx: 0 }];
  visited[entry] = true;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const children = succs[top.node];
    if (top.childIdx < children.length) {
      const next = children[top.childIdx];
      top.childIdx += 1;
      if (!visited[next]) {
        visited[next] = true;
        stack.push({ node: next, childIdx: 0 });
      }
    } else {
      post.push(top.node);
      stack.pop();
    }
  }
  const order = post.reverse();
  for (let b = 0; b < n; b++) if (!visited[b]) order.push(b);
  return order;
}

/**
 * Union predecessor lattices, sharing sets where possible. A normal edge
 * contributes OUT(from). A THROW edge contributes IN(from) ∪ allDefs(from):
 * an exception may fire before, between, or after any of the block's defs, so
 * the handler can observe the incoming state OR any intermediate def — OUT
 * alone (last-def-wins) misses defs overwritten later in the same block.
 * IN ∪ allDefs ⊇ OUT, so the throw contribution subsumes it.
 */
function mergePreds(
  preds: readonly { from: number; viaThrow: boolean }[],
  inSets: readonly Lattice[],
  outSets: readonly Lattice[],
  allDefsGen: readonly (Lattice | null)[],
): Lattice {
  const merged: Lattice = new Map();
  const mergeOne = (source: Lattice): void => {
    for (const [bindingIdx, set] of source) {
      const existing = merged.get(bindingIdx);
      if (!existing) {
        merged.set(bindingIdx, set); // share the first contributor's set
      } else if (existing !== set) {
        // Union only when the references differ. Copy-on-extend: `existing`
        // may be a shared set from another block — never mutate it.
        let target = existing;
        let copied = false;
        for (const key of set) {
          if (!target.has(key)) {
            if (!copied) {
              target = new Set(existing);
              copied = true;
            }
            target.add(key);
          }
        }
        if (copied) merged.set(bindingIdx, target);
      }
    }
  };
  for (const p of preds) {
    if (p.viaThrow) {
      mergeOne(inSets[p.from]); // exception may fire pre-defs…
      const all = allDefsGen[p.from];
      if (all) mergeOne(all); // …or after ANY of the block's defs
    } else {
      mergeOne(outSets[p.from]);
    }
  }
  return merged;
}

/** Order-stable union of two def-sets (shares `a` when `b` adds nothing). */
function unionSets(a: DefSet, b: DefSet): DefSet {
  let target = a;
  let copied = false;
  for (const key of b) {
    if (!target.has(key)) {
      if (!copied) {
        target = new Set(a);
        copied = true;
      }
      target.add(key);
    }
  }
  return target;
}

/** Per-binding equality with a reference fast path (sets only ever grow). */
function latticeEquals(a: Lattice, b: Lattice): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, bSet] of b) {
    const aSet = a.get(k);
    if (aSet === bSet) continue;
    if (!aSet || aSet.size !== bSet.size) return false;
    for (const v of bSet) if (!aSet.has(v)) return false;
  }
  return true;
}
