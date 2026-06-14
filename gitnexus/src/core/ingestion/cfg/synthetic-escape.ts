/**
 * Synthetic-escape pass for CDG soundness (#2197 U1).
 *
 * THE PROBLEM. Control dependence is computed over the post-dominator tree
 * (control-dependence.ts), which is only sound when EXIT is reverse-reachable
 * from every entry-reachable block (post-dominators.ts §
 * {@link isExitReachableFromAllBlocks}). Loop visitors keep that invariant by
 * giving every loop a structural `header → loopExit` `cond-false` edge — so an
 * ordinary `while`/`for` always has a path to EXIT. The `goto` handlers
 * (C/C++/C#/Go), however, wire an UNCONDITIONAL back-edge as plain `seq` with no
 * such escape:
 *
 *   void handler(int a){ start: if (a > 0) { work(); } goto start; }
 *
 * Here every body block sits in a trapping cycle (`start … goto start`) with no
 * path to EXIT, so EXIT is non-reverse-reachable and {@link emitFileCdg} (the
 * soundness gate) WITHHOLDS all control dependence for the whole function —
 * silent CDG coverage loss for an entire (common) class of functions.
 *
 * THE FIX (nontermination-sensitive control dependence — Ranganath et al.,
 * TOPLAS 2007). For a genuinely exit-unreachable *cycle* (an infinite loop), add
 * an ANALYSIS-ONLY virtual escape edge from the cycle's controlling branch to
 * EXIT, making the post-dom tree well-defined again. The synthetic edge is inert
 * in the Ferrante walk (EXIT post-dominates its source, so the post-dom guard
 * skips it) — it only restores reverse-reachability so the REAL control points
 * inside the loop get their dependences.
 *
 * ANALYSIS-ONLY (load-bearing — KTD7). The pass NEVER mutates the input. The
 * persisted CFG / REACHING_DEF graph and the byte-identical-off golden depend on
 * `cfg.edges` staying faithful, so the augmentation lives on a shallow-cloned
 * {@link FunctionCfg} whose `edges` is `[...cfg.edges, ...synthetic]`. Because
 * both {@link computePostDominators} AND {@link computeControlDependence}
 * (its Ferrante walk + `buildArmSenses`) re-read `cfg.edges` directly, the
 * augmented view must be passed to BOTH — feeding only an augmented post-dom
 * tree would leave the walk on the un-augmented edges (KTD7).
 *
 * PURE AND DETERMINISTIC (mirrors post-dominators.ts / reaching-defs.ts). The
 * SCC routine sorts every adjacency list and emits SCCs root-deterministically,
 * so the chosen representative — hence the augmented edge set and any downstream
 * snapshot — is identical across runs.
 *
 * WHICH SCCs ARE BRIDGED (KTD2 / KTD6, and the anti-masking guarantee R2). The
 * decision is gated on the WHOLE entry-reachable trapped region (the union of
 * the entry-reachable blocks that cannot reach EXIT): the pass bridges only when
 * that region contains at least one *control point* — a block with ≥2 successors
 * (a branch terminator). A region with a control point is a real, recoverable
 * loop (a `goto`-cycle always carries the `if` predicate from its guard); a
 * region with NO control point is a branch-less infinite spin that carries no
 * control dependence to recover AND is indistinguishable from a genuine
 * CFG-construction anomaly (e.g. a disconnected EXIT block), so it is
 * deliberately LEFT UNBRIDGED — the existing soundness gate then skips the
 * function and surfaces the skip (R2 / R3). In practice a branch-less trapping
 * region never comes from a real loop visitor (loops emit the structural escape
 * edge) — it signals a construction error, exactly what we must not paper over.
 *
 * When the region is bridged, EACH exit-less SCC gets one synthetic escape edge
 * from its *controlling representative*: the entry-reachable member with a branch
 * terminator (≥2 successors), highest out-degree, lowest-index tie-break. That
 * branch is the predicate deciding stay-in-loop vs. leave, the faithful escape
 * representative; attaching the escape anywhere else invents or drops CDG edges
 * while still passing the AC2 post-dominance property test, so the choice is
 * pinned by an exact-edge-set test, not `CDG>0`. When an exit-less SCC has NO
 * internal branch (e.g. the body of an irreducible loop whose control point sits
 * OUTSIDE the cycle), its escape attaches to the lowest-index member — the
 * choice is semantically immaterial (the SCC has no internal control point so it
 * contributes no internal CDG), and a deterministic index keeps snapshots
 * stable. This per-SCC bridging restores reverse-reachability for the whole
 * region in one batch, then the gate re-checks (KTD2).
 *
 * GRANULARITY OF A MIXED cycle + dead-end FUNCTION. {@link emitFileCdg} is
 * all-or-nothing per function: it computes CDG only when EXIT is reverse-
 * reachable from EVERY entry-reachable block. So if a function contains a
 * recoverable goto-cycle AND a *separate* residual block that is still
 * exit-unreachable after all escapes (a dangling/dead-end block not in any
 * bridgeable cycle), the pass restores the cycle but the residual block keeps
 * EXIT non-reverse-reachable → the WHOLE function is still skipped and surfaced.
 * We do NOT bridge the residual (that would mask the construction error), and we
 * do NOT emit partial per-cycle CDG (the emit layer has no partial mode). This
 * is the documented, intentional trade-off: recover the common goto-cycle case;
 * surface anything with a genuine residual anomaly rather than guess.
 */
import { isExitReachableFromAllBlocks, type PostDomTree } from './post-dominators.js';
import type { CfgEdgeData, FunctionCfg } from './types.js';

/**
 * The synthetic escape edge kind. Reuses the existing `cond-false` kind (the
 * same kind every loop's structural `header → loopExit` escape carries — see the
 * module doc), so the augmented view is structurally indistinguishable from a
 * normally-escaped loop and `buildArmSenses`/`labelFor` treat it identically.
 * The edge is analysis-only and never persisted.
 */
const SYNTHETIC_ESCAPE_KIND: CfgEdgeData['kind'] = 'cond-false';

/** Forward / reverse reachability over a CFG's in-range edges. */
interface Reachability {
  /** `fromEntry[b]` — block `b` is forward-reachable from ENTRY. */
  readonly fromEntry: Uint8Array;
  /** `canReachExit[b]` — block `b` can reach EXIT (reverse-reachable from it). */
  readonly canReachExit: Uint8Array;
  /** Forward adjacency (sorted, in-range). */
  readonly succ: readonly number[][];
}

function reach(start: number, adj: readonly number[][], n: number): Uint8Array {
  const seen = new Uint8Array(n);
  if (start < 0 || start >= n) return seen;
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const b = stack.pop() as number;
    for (const next of adj[b]) {
      if (!seen[next]) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return seen;
}

function computeReachability(cfg: FunctionCfg): Reachability {
  const n = cfg.blocks.length;
  const succ: number[][] = Array.from({ length: n }, () => []);
  const pred: number[][] = Array.from({ length: n }, () => []);
  for (const e of cfg.edges) {
    if (e.from < 0 || e.from >= n || e.to < 0 || e.to >= n) continue;
    succ[e.from].push(e.to);
    pred[e.to].push(e.from);
  }
  // Sorted adjacency — determinism (mirrors post-dominators.ts).
  for (const l of succ) l.sort((a, b) => a - b);
  return {
    fromEntry: reach(cfg.entryIndex, succ, n),
    canReachExit: reach(cfg.exitIndex, pred, n),
    succ,
  };
}

/**
 * Strongly-connected components of a CFG via an ITERATIVE Tarjan over the
 * forward edges. Pure and deterministic: nodes are visited in ascending index
 * and every successor list is iterated in sorted order, so the component
 * partition (and the per-component member order) is identical across runs.
 *
 * Returns `compOf[b]` = the component id of block `b`, plus `members[c]` = the
 * (ascending-index) members of component `c`. Component ids are assigned in
 * Tarjan completion order (a reverse-topological order over the condensation),
 * which is deterministic but not relied upon — callers key on `compOf`.
 */
export interface SccResult {
  readonly compOf: readonly number[];
  readonly members: readonly (readonly number[])[];
}

export function computeScc(succ: readonly number[][], n: number): SccResult {
  const compOf = new Array<number>(n).fill(-1);
  const members: number[][] = [];

  const index = new Array<number>(n).fill(-1);
  const lowlink = new Array<number>(n).fill(0);
  const onStack = new Uint8Array(n);
  const tarjanStack: number[] = [];
  let nextIndex = 0;

  // Explicit work stack: each frame tracks the node and how far through its
  // (sorted) successor list we have iterated, so recursion depth never blows the
  // JS stack on a large per-function CFG.
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: { node: number; childIdx: number }[] = [{ node: root, childIdx: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.node;
      if (frame.childIdx === 0) {
        // First visit to v.
        index[v] = nextIndex;
        lowlink[v] = nextIndex;
        nextIndex += 1;
        tarjanStack.push(v);
        onStack[v] = 1;
      }
      const succs = succ[v];
      if (frame.childIdx < succs.length) {
        const w = succs[frame.childIdx];
        frame.childIdx += 1;
        if (index[w] === -1) {
          // Descend into the unvisited child; resume v afterwards.
          work.push({ node: w, childIdx: 0 });
        } else if (onStack[w]) {
          if (index[w] < lowlink[v]) lowlink[v] = index[w];
        }
        continue;
      }
      // All successors of v processed: propagate lowlink to the parent, and if v
      // is a component root, pop its component off the Tarjan stack.
      if (lowlink[v] === index[v]) {
        const comp: number[] = [];
        for (;;) {
          const w = tarjanStack.pop() as number;
          onStack[w] = 0;
          comp.push(w);
          if (w === v) break;
        }
        comp.sort((a, b) => a - b); // ascending member order — determinism
        const id = members.length;
        for (const w of comp) compOf[w] = id;
        members.push(comp);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        if (lowlink[v] < lowlink[parent]) lowlink[parent] = lowlink[v];
      }
    }
  }

  return { compOf, members };
}

/**
 * Restore EXIT reverse-reachability for genuine exit-unreachable cycles so the
 * post-dom / CDG pass runs on a well-defined tree, WITHOUT masking construction
 * errors or perturbing sound functions. See the module doc for the full
 * contract.
 *
 * Returns the input `cfg` UNCHANGED (referential no-op) when EXIT is already
 * reverse-reachable from every entry-reachable block — terminating functions and
 * properly-escaped loops are byte-identical (zero synthetic edges). Otherwise
 * returns a SHALLOW-CLONED {@link FunctionCfg} whose `edges` is the original
 * edges followed by the synthetic escapes; the input's `edges` is never mutated.
 *
 * Pass the returned view to BOTH {@link computePostDominators} and
 * {@link computeControlDependence} (KTD7).
 */
export function augmentForPostDom(cfg: FunctionCfg): FunctionCfg {
  const n = cfg.blocks.length;
  const { entryIndex, exitIndex } = cfg;
  if (n === 0 || entryIndex < 0 || entryIndex >= n || exitIndex < 0 || exitIndex >= n) {
    return cfg; // degenerate — leave to the existing gate
  }

  const { fromEntry, canReachExit, succ } = computeReachability(cfg);

  // No-op fast path: every entry-reachable block already reaches EXIT.
  let allReach = true;
  for (let b = 0; b < n; b++) {
    if (fromEntry[b] && !canReachExit[b]) {
      allReach = false;
      break;
    }
  }
  if (allReach) return cfg;

  // Anti-masking gate (R2): only bridge when the entry-reachable TRAPPED REGION
  // (the union of entry-reachable blocks that cannot reach EXIT) holds at least
  // one control point — a block with ≥2 successors. A branch-less trapped region
  // is a degenerate spin / construction anomaly we refuse to mask; the existing
  // soundness gate skips it and surfaces the skip. A real `goto`-cycle always
  // carries its guard's `if`, so it is recovered; a disconnected/dangling EXIT
  // (no branch anywhere in the trap) is left to skip. See the module doc.
  let regionHasControlPoint = false;
  for (let b = 0; b < n; b++) {
    if (fromEntry[b] && !canReachExit[b] && succ[b].length >= 2) {
      regionHasControlPoint = true;
      break;
    }
  }
  if (!regionHasControlPoint) return cfg;

  // Condense into SCCs over the real edges.
  const { members } = computeScc(succ, n);

  // Bridge EACH exit-less SCC (a trapping cycle: no member can reach EXIT, so
  // `canReachExit` is false for the whole SCC). `canReachExit` already encodes
  // the transitive closure, so a single member's flag answers it for the SCC.
  const synthetic: CfgEdgeData[] = [];
  for (const comp of members) {
    if (comp.length === 0) continue;
    const rep = comp[0]; // ascending-order members → comp[0] is the lowest index
    if (canReachExit[rep]) continue; // SCC escapes to EXIT — nothing to bridge
    // Only genuine CYCLES trap. A singleton SCC with no self-edge is an ordinary
    // acyclic block (ENTRY / the spine) that is exit-unreachable only because it
    // FEEDS a trap downstream; it gets its path to EXIT for free once the trap is
    // bridged, so it is never bridged on its own.
    const isCycle = comp.length > 1 || cfg.edges.some((e) => e.from === rep && e.to === rep);
    if (!isCycle) continue;

    // Controlling representative: the entry-reachable member with a branch
    // terminator (≥2 successors), highest out-degree, lowest-index tie-break.
    // When the SCC has no internal branch (its control point sits outside, e.g.
    // an irreducible loop body), fall back to the lowest-index member — the
    // choice is immaterial (no internal control point ⇒ no internal CDG) and a
    // deterministic index keeps snapshots stable (KTD6).
    let controller = -1;
    let bestOutDeg = 1; // require ≥2 to qualify as a branch
    for (const b of comp) {
      if (!fromEntry[b]) continue;
      const outDeg = succ[b].length;
      if (outDeg >= 2 && outDeg > bestOutDeg) {
        bestOutDeg = outDeg;
        controller = b;
      }
    }
    if (controller === -1) {
      // No internal branch — attach at the lowest entry-reachable member (or the
      // lowest member if none is entry-reachable, a defensive fallback).
      controller = comp.find((b) => fromEntry[b]) ?? rep;
    }

    synthetic.push({ from: controller, to: exitIndex, kind: SYNTHETIC_ESCAPE_KIND });
  }

  if (synthetic.length === 0) return cfg; // nothing bridgeable — gate will skip

  // Shallow clone with the augmented edge set; the input's `edges` is untouched.
  return { ...cfg, edges: [...cfg.edges, ...synthetic] };
}

/**
 * Convenience: `true` iff {@link augmentForPostDom} returned a DIFFERENT object
 * (i.e. at least one synthetic escape edge was added). Useful for tests
 * asserting the no-op path. Reference equality is exact: the no-op path returns
 * the input unchanged.
 */
export function wasAugmented(cfg: FunctionCfg, view: FunctionCfg): boolean {
  return view !== cfg;
}

// Re-export so callers can build the augmented view and gate it in one import.
export { isExitReachableFromAllBlocks };
export type { PostDomTree };
