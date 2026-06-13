/**
 * Control dependence (#2085 M5 U3) — Ferrante, Ottenstein & Warren §3.1.1 over
 * the post-dominator tree. A block `dependent` is control-dependent on a branch
 * block `controller` when `controller` decides whether `dependent` executes:
 * formally, there is a CFG edge `controller → B` such that `dependent`
 * post-dominates `B` but does NOT strictly post-dominate `controller`.
 *
 * Construction (§3.1.1): for each CFG edge `(A, B)` where `B` does NOT
 * post-dominate `A`, walk UP the post-dom tree from `B` to (but not including)
 * `ipdom(A)`; every block on that path is control-dependent on `A`. The branch
 * SENSE of the edge ('T' | 'F') becomes the edge label (KTD4 / KTD3 — it rides
 * the persisted relation's `reason` column).
 *
 * PURE AND DETERMINISTIC (mirrors post-dominators.ts / reaching-defs.ts): no
 * graph, no logger, importable outside the worker; output is deduped per
 * (controller, dependent, label) and sorted, so snapshot tests and
 * content-derived edge ids are stable. The loop header legitimately appears as
 * control-dependent on ITSELF (`controller === dependent`) — the loop predicate
 * gates its own re-execution; this is standard PDG behavior, not a bug.
 */
import {
  computePostDominators,
  postDominates,
  NO_IPDOM,
  type PostDomTree,
} from './post-dominators.js';
import type { CfgEdgeKind, FunctionCfg } from './types.js';

export type CdgLabel = 'T' | 'F';

export interface ControlDepEdge {
  /** The branch block whose outcome controls `dependentBlock`. */
  readonly controllerBlock: number;
  /** The block that executes only because `controllerBlock` took `label`. */
  readonly dependentBlock: number;
  /** Branch sense of the controlling CFG edge — see {@link branchSense}. */
  readonly label: CdgLabel;
}

/**
 * Map a CFG edge kind to a CDG branch label (KTD4). The taken/positive senses
 * (`cond-true`, a `switch` case dispatch, a loop back-edge) are 'T'; the
 * not-taken/fallthrough senses are 'F'. Unconditional jumps
 * (`break`/`continue`/`return`/`throw`/`seq`/`finally-*`) come from
 * single-successor or non-predicate blocks and only reach this pass when they
 * leave a guarded region; they default to 'T'. Per-case `switch` value labels
 * are deferred to #2086 — every case is 'T' in M5.
 */
function branchSense(kind: CfgEdgeKind): CdgLabel {
  switch (kind) {
    case 'cond-false':
    case 'fallthrough':
      return 'F';
    case 'cond-true':
    case 'switch-case':
    case 'loop-back':
    case 'break':
    case 'continue':
    case 'return':
    case 'throw':
    case 'seq':
    case 'finally-return':
    case 'finally-break':
    case 'finally-continue':
      return 'T';
    default: {
      // Exhaustiveness: a new CfgEdgeKind must consciously pick a sense here.
      const _exhaustive: never = kind;
      return 'T';
    }
  }
}

/**
 * Compute control-dependence edges for one function's CFG. `postDom` may be
 * supplied to reuse an already-built tree; otherwise it is computed. See the
 * module doc for the purity/determinism contract.
 */
export function computeControlDependence(
  cfg: FunctionCfg,
  postDom?: PostDomTree,
): readonly ControlDepEdge[] {
  const tree = postDom ?? computePostDominators(cfg);
  const { ipdom } = tree;
  const n = cfg.blocks.length;

  const out: ControlDepEdge[] = [];
  const seen = new Set<string>();

  for (const e of cfg.edges) {
    const a = e.from;
    const b = e.to;
    if (a < 0 || a >= n || b < 0 || b >= n) continue;
    // No control dependence when B post-dominates A — every path leaving A
    // through this edge still reaches B, so A does not decide B's execution.
    // This guard is exactly AC2: a dependence exists IFF post-dominance fails.
    if (postDominates(tree, b, a)) continue;

    const label = branchSense(e.kind);
    const stop = ipdom[a]; // walk up to ipdom(A), EXCLUSIVE (NO_IPDOM ⇒ to root)
    let cur = b;
    let steps = 0;
    // `steps <= n` is defensive — the ipdom chain is a finite tree.
    while (cur !== NO_IPDOM && cur !== stop && steps <= n) {
      const key = `${a}:${cur}:${label}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ controllerBlock: a, dependentBlock: cur, label });
      }
      cur = ipdom[cur];
      steps += 1;
    }
  }

  out.sort(
    (x, y) =>
      x.controllerBlock - y.controllerBlock ||
      x.dependentBlock - y.dependentBlock ||
      (x.label < y.label ? -1 : x.label > y.label ? 1 : 0),
  );
  return out;
}
