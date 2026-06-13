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

export interface ControlDepResult {
  /** Deduped, sorted (controller, dependent, label) control-dependence edges. */
  readonly edges: readonly ControlDepEdge[];
  /**
   * True when the `maxEdges` ceiling was reached; `edges` is then a
   * deterministic prefix (CFG-edge iteration order, sorted), never a silent
   * drop. Mirrors {@link computeReachingDefs}'s `truncated`.
   */
  readonly truncated: boolean;
}

/**
 * Per-controller branch-arm senses, derived from the controller block's OUTGOING
 * edge kinds. The CFG edge kind alone cannot name a branch sense: the M1 visitor
 * emits an explicit `cond-true`/`cond-false` only for a `then`/`else` arm, but a
 * condition's FALL-THROUGH false arm (no-`else`, or a guard's `if (!ok) return;`)
 * is wired as `seq`, and an `if` ending a loop body falls through as `loop-back`
 * — while a `do/while` bottom-test's TRUE arm is also a `loop-back`. So `seq`
 * and `loop-back` are genuinely ambiguous in isolation (issue #2188 F1).
 *
 * The fix reads the sense from the CONTROLLER's structure: a 2-way branch emits
 * exactly one explicitly-sensed arm (`cond-true`/`switch-case` ⇒ true, or
 * `cond-false` ⇒ false), and its other (ambiguous) arm is the COMPLEMENT. This
 * map records which explicit senses each block emits so {@link labelFor} can
 * resolve an ambiguous edge against its sibling.
 */
interface ArmSenses {
  hasTrueArm: boolean; // emits a cond-true or switch-case edge
  hasFalseArm: boolean; // emits a cond-false edge
}

function buildArmSenses(cfg: FunctionCfg): ArmSenses[] {
  const n = cfg.blocks.length;
  const senses: ArmSenses[] = Array.from({ length: n }, () => ({
    hasTrueArm: false,
    hasFalseArm: false,
  }));
  for (const e of cfg.edges) {
    if (e.from < 0 || e.from >= n) continue;
    if (e.kind === 'cond-true' || e.kind === 'switch-case') senses[e.from].hasTrueArm = true;
    else if (e.kind === 'cond-false') senses[e.from].hasFalseArm = true;
  }
  return senses;
}

/**
 * The CDG label ('T'|'F') for a control-dependence edge, given the controlling
 * block's arm senses. An explicitly-sensed edge is taken at face value; an
 * ambiguous fall-through edge (`seq`/`loop-back`/`fallthrough`/jump) is the
 * COMPLEMENT of the controller's explicit sibling arm. Per-case `switch` value
 * labels are deferred to #2086 — every `switch-case` is 'T' in M5.
 */
function labelFor(kind: CfgEdgeKind, controller: ArmSenses): CdgLabel {
  if (kind === 'cond-true' || kind === 'switch-case') return 'T';
  if (kind === 'cond-false') return 'F';
  // Ambiguous structural kind: take the complement of the controller's explicit
  // arm. A block with a true arm reaches here via its false fall-through; a
  // do/while bottom-test (false arm = cond-false) reaches here via its true
  // loop-back. With neither explicit arm (a degenerate / exit-unreachable
  // region — see #2188 F2, where the dependence itself is unsound) the sense is
  // indeterminate; default 'F' since fall-through is the common case.
  if (controller.hasTrueArm) return 'F';
  if (controller.hasFalseArm) return 'T';
  return 'F';
}

/**
 * Compute control-dependence edges for one function's CFG. `postDom` may be
 * supplied to reuse an already-built tree; otherwise it is computed. See the
 * module doc for the purity/determinism contract.
 */
export function computeControlDependence(
  cfg: FunctionCfg,
  postDom?: PostDomTree,
  // Heap-safety ceiling on materialized edges, mirroring computeReachingDefs'
  // `maxFacts` (#2188 review): the pre-dedup walk is O(edges × post-dom depth),
  // so bound it before it can spike. `0` ⇒ unbounded. On overflow `edges` is a
  // deterministic prefix and `truncated` is set — never a silent drop.
  maxEdges: number = 0,
): ControlDepResult {
  const tree = postDom ?? computePostDominators(cfg);
  const { ipdom } = tree;
  const n = cfg.blocks.length;
  const armSenses = buildArmSenses(cfg);
  const cap = maxEdges > 0 ? maxEdges : Infinity;

  const out: ControlDepEdge[] = [];
  const seen = new Set<string>();
  let truncated = false;

  scan: for (const e of cfg.edges) {
    const a = e.from;
    const b = e.to;
    if (a < 0 || a >= n || b < 0 || b >= n) continue;
    // No control dependence when B post-dominates A — every path leaving A
    // through this edge still reaches B, so A does not decide B's execution.
    // This guard is exactly AC2: a dependence exists IFF post-dominance fails.
    if (postDominates(tree, b, a)) continue;

    // Sense is read from the CONTROLLER's arms, not this edge's kind alone —
    // seq/loop-back fall-through false arms would otherwise mislabel as 'T'
    // (#2188 F1).
    const label = labelFor(e.kind, armSenses[a]);
    const stop = ipdom[a]; // walk up to ipdom(A), EXCLUSIVE (NO_IPDOM ⇒ to root)
    let cur = b;
    let steps = 0;
    // `steps <= n` is defensive — the ipdom chain is a finite tree.
    while (cur !== NO_IPDOM && cur !== stop && steps <= n) {
      const key = `${a}:${cur}:${label}`;
      if (!seen.has(key)) {
        // Check BEFORE pushing so `truncated` means a genuine overflow (a new
        // unique edge had to be dropped), not merely "reached the ceiling" —
        // exactly `cap` edges is a full, non-truncated result.
        if (out.length >= cap) {
          truncated = true;
          break scan;
        }
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
  return { edges: out, truncated };
}
