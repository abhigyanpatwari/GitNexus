/**
 * Reaching definitions (#2082 M2 U3, SSA-sparse rewrite #2201) — per-function
 * intraprocedural may-reaching-definitions, plus the canonical intra-block
 * statement sweep that recovers statement-granular def→use facts from M1's
 * coalesced blocks WITHOUT re-splitting the CFG.
 *
 * ARCHITECTURE (#2201): the analysis is split into solver-INDEPENDENT stages
 * (shared by both solvers, so the byte-identical surface is maximal) and a
 * swappable IN-set computation:
 *   - {@link harvestStatementFacts} — per-block GEN/allDefs + def/use telemetry.
 *   - {@link buildAdjacency} — throw-aware predecessor/successor adjacency.
 *   - the IN-set computer — produces per-block entry reaching lattices. Two
 *     exist: {@link computeInSetsSparse} (production, change-driven per binding)
 *     and {@link computeInSetsDense} (the original GEN/KILL worklist, RETAINED
 *     as the differential equivalence oracle). They MUST produce identical
 *     inSets, including set INSERTION order (the maxFacts-truncated subset
 *     depends on the sweep's pre-sort emission order — see {@link sweepFacts}).
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
   * Adversarial-only safety bound on solver work.
   *
   * The DENSE oracle reads this as a ceiling on total block dequeues: iterative
   * reaching-defs on a reducible CFG converges in O(loop-nesting-depth) passes,
   * but a pathologically deep loop nest drives the visit total — and thus the
   * solver — to O(blocks²), seconds + GB of heap (`maxFacts` does not help: fact
   * count stays linear).
   *
   * The SPARSE solver (#2201) reads it as a ceiling on total (block, binding)
   * dequeues. Because the sparse solve is change-driven per binding, realistic
   * deep nests (loop-local / shallow variables) cost ~O(blocks) and complete far
   * under this budget — the ceiling that fired on the dense worklist effectively
   * never fires on real code. A single variable threaded through every level of
   * an adversarial deep nest is the one residual O(depth²) shape (a documented
   * SSA follow-up); it still bails soundly here.
   *
   * On either solver, exceeding the budget means the fixpoint has NOT converged,
   * so any facts would be unsound — the solver bails to a sound empty
   * `status: 'truncated'` (like the `overflow` guard). `undefined`/0 ⇒ unlimited
   * (the default for direct callers; the emit path sets a per-function budget).
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
 * The swappable stage: per-block entry reaching lattices, or a non-convergence
 * signal (maxBlockVisits exceeded ⇒ sound empty `truncated`). The two
 * implementations MUST agree byte-for-byte, including set insertion order.
 */
type InSetsResult = { converged: true; inSets: Lattice[] } | { converged: false };

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
 * This is the production entry point. As of #2201 it runs the sparse, change-
 * driven solver ({@link computeInSetsSparse}); the dense GEN/KILL worklist
 * ({@link computeReachingDefsDense}) is retained as the differential
 * equivalence oracle the fuzz suite checks the sparse path against — the two
 * MUST be byte-identical (status, bindings, sorted facts, def/use telemetry).
 */
export function computeReachingDefs(cfg: FunctionCfg, limits?: ReachingDefsLimits): FunctionDefUse {
  // #2201: production still runs the dense solver until U5 flips this to
  // computeInSetsSparse (once the differential fuzz is byte-identical green).
  return solveReachingDefs(cfg, limits, computeInSetsDense);
}

/**
 * Dense GEN/KILL monotone worklist — the original (#2082 M2) reaching-defs
 * solver. As of #2201 this is RETAINED AS A TEST/BENCH-ONLY DIFFERENTIAL
 * ORACLE, not a production code path: {@link computeReachingDefs} runs the
 * sparse solver, and the equivalence fuzz asserts the two are byte-identical
 * across a random-CFG corpus. Keep it behavior-frozen — it is the ground truth.
 *
 * @internal exported only for the equivalence fuzz harness and the cfg bench.
 */
export function computeReachingDefsDense(
  cfg: FunctionCfg,
  limits?: ReachingDefsLimits,
): FunctionDefUse {
  return solveReachingDefs(cfg, limits, computeInSetsDense);
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
  const { facts, truncated } = sweepFacts(blocks, solved.inSets, h.defLine, maxFacts);

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
 * merges, not visitation order. The asymptotic fix is the sparse, change-driven
 * solver ({@link computeInSetsSparse}); this dense version is retained only as
 * the differential equivalence oracle.
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

  return { converged: true, inSets };
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
  inSets: readonly Lattice[],
  defLine: ReadonlyMap<number, number>,
  maxFacts: number,
): { facts: DefUseFact[]; truncated: boolean } {
  const facts: DefUseFact[] = [];
  let truncated = false;

  outer: for (const b of blocks) {
    const stmts = b.statements;
    if (!stmts || stmts.length === 0) continue;
    // Lazy overlay of IN — entries are replaced (never mutated) on def, so the
    // shared sets stay intact.
    let reach: Lattice | null = null;
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
        const reaching = (reach ?? inSets[b.index]).get(u);
        const selfKey = sameStmtDefs?.has(u) ? defKey(b.index, i) : undefined;
        if (!reaching && selfKey === undefined) continue;
        const keys =
          selfKey !== undefined && !reaching?.has(selfKey)
            ? [...(reaching ?? []), selfKey]
            : [...(reaching ?? [])];
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
        if (!reach) reach = new Map(inSets[b.index]);
        const key = defKey(b.index, i);
        for (const d of s.mayDefs) {
          const prior = reach.get(d);
          reach.set(d, prior ? unionSets(prior, new Set([key])) : new Set([key]));
        }
      }
      if (s.defs.length > 0) {
        if (!reach) reach = new Map(inSets[b.index]);
        for (const d of s.defs) reach.set(d, new Set([defKey(b.index, i)])); // kill + gen
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
