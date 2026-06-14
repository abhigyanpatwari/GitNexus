/**
 * Post-dominators (#2085 M5 U2) — the immediate-post-dominator tree of one
 * function's CFG, the substrate the Ferrante control-dependence pass walks.
 *
 * A block `p` post-dominates a block `b` iff every path from `b` to the
 * function EXIT passes through `p`. Post-dominators are exactly the DOMINATORS
 * of the REVERSE CFG rooted at EXIT, so this is the Cooper–Harvey–Kennedy
 * "A Simple, Fast Dominance Algorithm" run over reversed edges. KTD2 of the M5
 * plan picks CHK over Lengauer–Tarjan: per-function CFGs are small and
 * line-capped, CHK is near-linear in practice, and its iterative shape matches
 * the reaching-defs fixpoint already in this module.
 *
 * PURE AND DETERMINISTIC (load-bearing, mirrors reaching-defs.ts): no graph, no
 * logger, importable outside the worker; predecessors/successors are sorted and
 * iteration is reverse-postorder so the `ipdom` array is identical across runs
 * (snapshot tests and content-derived edge ids depend on it).
 *
 * The single-EXIT invariant the M1 TS visitor preserves (visitors/typescript.ts)
 * makes EXIT the unique reverse-CFG root. Blocks that cannot reach EXIT in the
 * forward CFG (an exit-less infinite loop) are not reverse-reachable from it and
 * have NO post-dominator: their `ipdom` is {@link NO_IPDOM}. The control-
 * dependence pass treats "no post-dominator" as "does not post-dominate" (KTD5).
 *
 * NOTE (issue #2188 F2): this is NOT a fully sound over-approximation. Inside a
 * region where NO block reaches EXIT, every `ipdom` is `NO_IPDOM`, so the
 * Ferrante walk degenerates to one edge per control point — it can both DROP a
 * real control dependence and INVENT a spurious one. This does not arise for the
 * current TS visitor (every loop is given a structural `header → loopExit`
 * `cond-false` edge, so EXIT stays reverse-reachable), but it is unsound for
 * hand-built CFGs and any future language visitor lacking that exit edge.
 * Nontermination-sensitive post-dominance (a virtual root over the
 * non-terminating SCCs) would be the correct treatment — tracked for follow-up.
 */
import type { FunctionCfg } from './types.js';

/**
 * Sentinel `ipdom` value: the block has no immediate post-dominator. True for
 * the EXIT block itself (the reverse-CFG root) and for any block that cannot
 * reach EXIT. Chosen as -1 so the {@link postDominates} climb terminates
 * naturally instead of self-looping on the root.
 */
export const NO_IPDOM = -1;

export interface PostDomTree {
  /**
   * `ipdom[b]` = the index of `b`'s immediate post-dominator, or
   * {@link NO_IPDOM} when `b` has none (EXIT, or a block that cannot reach EXIT).
   */
  readonly ipdom: readonly number[];
}

/**
 * Compute the immediate-post-dominator tree for one function's CFG. See the
 * module doc for the purity/determinism contract and EXIT-root assumptions.
 */
export function computePostDominators(cfg: FunctionCfg): PostDomTree {
  const n = cfg.blocks.length;
  const exit = cfg.exitIndex;
  if (n === 0 || exit < 0 || exit >= n) {
    return { ipdom: new Array<number>(n).fill(NO_IPDOM) };
  }

  // Forward adjacency (sorted for deterministic intersect order). The reverse
  // CFG, on which we compute dominators, flips these: a node's reverse-CFG
  // successors are its CFG predecessors, and its reverse-CFG predecessors
  // (the "preds" CHK intersects over) are its CFG successors.
  const cfgPreds: number[][] = Array.from({ length: n }, () => []);
  const cfgSuccs: number[][] = Array.from({ length: n }, () => []);
  for (const e of cfg.edges) {
    if (e.from < 0 || e.from >= n || e.to < 0 || e.to >= n) continue;
    cfgSuccs[e.from].push(e.to);
    cfgPreds[e.to].push(e.from);
  }
  for (const l of cfgPreds) l.sort((a, b) => a - b);
  for (const l of cfgSuccs) l.sort((a, b) => a - b);

  // Postorder of the reverse CFG from EXIT (traversing CFG-predecessor edges).
  // Iterative DFS with an explicit phase stack; children pushed in sorted order
  // for determinism. postNum is the CHK comparison key: higher = closer to root.
  const postNum = new Array<number>(n).fill(-1);
  const postorder: number[] = [];
  const visited = new Array<boolean>(n).fill(false);
  const stack: { node: number; childIdx: number }[] = [{ node: exit, childIdx: 0 }];
  visited[exit] = true;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const revSuccs = cfgPreds[top.node]; // reverse-CFG successors
    if (top.childIdx < revSuccs.length) {
      const next = revSuccs[top.childIdx];
      top.childIdx += 1;
      if (!visited[next]) {
        visited[next] = true;
        stack.push({ node: next, childIdx: 0 });
      }
    } else {
      postNum[top.node] = postorder.length;
      postorder.push(top.node);
      stack.pop();
    }
  }
  const rpo = [...postorder].reverse();

  // CHK fixpoint. ipdom[exit] = exit DURING computation (the root dominates
  // itself, so the intersect climb has a common terminus); it is reset to
  // NO_IPDOM before returning so callers' climbs terminate at the root.
  const ipdom = new Array<number>(n).fill(NO_IPDOM);
  ipdom[exit] = exit;

  const intersect = (a: number, b: number): number => {
    let f1 = a;
    let f2 = b;
    while (f1 !== f2) {
      while (postNum[f1] < postNum[f2]) f1 = ipdom[f1];
      while (postNum[f2] < postNum[f1]) f2 = ipdom[f2];
    }
    return f1;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === exit) continue;
      // CHK "predecessors in the reverse CFG" = this block's CFG successors.
      // Fold only those already processed (ipdom assigned); RPO guarantees at
      // least one for every block reverse-reachable from EXIT.
      let newIpdom = NO_IPDOM;
      for (const s of cfgSuccs[b]) {
        if (ipdom[s] !== NO_IPDOM) {
          newIpdom = newIpdom === NO_IPDOM ? s : intersect(s, newIpdom);
        }
      }
      if (newIpdom !== NO_IPDOM && ipdom[b] !== newIpdom) {
        ipdom[b] = newIpdom;
        changed = true;
      }
    }
  }

  ipdom[exit] = NO_IPDOM; // root: no post-dominator above it
  return { ipdom };
}

/**
 * Does block `p` post-dominate block `b`? Climbs the post-dom tree from `b`
 * toward EXIT and tests membership of `p`. Reflexive: a block post-dominates
 * itself. A block with no post-dominator (EXIT, or one that cannot reach EXIT)
 * is post-dominated only by itself. The step guard is purely defensive — the
 * `ipdom` chain is a tree and always terminates at {@link NO_IPDOM}.
 */
export function postDominates(tree: PostDomTree, p: number, b: number): boolean {
  const { ipdom } = tree;
  const n = ipdom.length;
  if (p < 0 || b < 0 || p >= n || b >= n) return false;
  let cur = b;
  let steps = 0;
  while (cur !== NO_IPDOM && steps <= n) {
    if (cur === p) return true;
    cur = ipdom[cur];
    steps += 1;
  }
  return false;
}

/**
 * Precondition for SOUND post-dominance (#2188 review): EXIT must be reachable
 * (forward) from every block that is itself reachable from ENTRY. When it
 * fails — an entry-reachable region that cannot reach EXIT, e.g. a
 * non-terminating loop or a multi-terminal CFG a future language visitor might
 * emit — the EXIT-rooted reverse walk degenerates (every such block gets
 * {@link NO_IPDOM}), which both DROPS real control dependences and INVENTS
 * spurious ones (the unsoundness documented in the module header). Consumers
 * ({@link emitFileCdg}) check this and skip CDG for the function rather than
 * persist an unsound projection — CFG and REACHING_DEF, which do not depend on
 * post-dominance, are unaffected.
 *
 * The current TS visitor always satisfies this (every loop is given a
 * structural `header → loopExit` edge, keeping EXIT reverse-reachable), so this
 * is a guard for future visitors and hand-built CFGs, not a behavior change
 * today. Pure and O(V+E).
 */
export function isExitReachableFromAllBlocks(cfg: FunctionCfg): boolean {
  const n = cfg.blocks.length;
  if (n === 0) return true;
  const { entryIndex, exitIndex } = cfg;
  if (entryIndex < 0 || entryIndex >= n || exitIndex < 0 || exitIndex >= n) return false;

  const succ: number[][] = Array.from({ length: n }, () => []);
  const pred: number[][] = Array.from({ length: n }, () => []);
  for (const e of cfg.edges) {
    if (e.from < 0 || e.from >= n || e.to < 0 || e.to >= n) continue;
    succ[e.from].push(e.to);
    pred[e.to].push(e.from);
  }

  const reach = (start: number, adj: readonly number[][]): Uint8Array => {
    const seen = new Uint8Array(n);
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
  };

  const fromEntry = reach(entryIndex, succ); // forward-reachable from ENTRY
  const canReachExit = reach(exitIndex, pred); // can reach EXIT (reverse from EXIT)
  for (let i = 0; i < n; i++) {
    if (fromEntry[i] && !canReachExit[i]) return false;
  }
  return true;
}
