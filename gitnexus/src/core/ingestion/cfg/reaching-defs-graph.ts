/**
 * Pure graph sub-stages for the reaching-definitions solvers (#2201 review R4).
 *
 * Extracted from reaching-defs.ts to keep that module focused on the
 * orchestrator, the dense oracle, the statement sweep, and the dispatcher.
 * Everything here is a pure function of plain arrays — no CFG, no harvest, no
 * solver state — so this module has NO dependency on reaching-defs.ts (a strict
 * one-way import) and each stage is independently testable. The SSA pipeline
 * (dominators → dominance frontiers → Tarjan SCC → reach-set condensation)
 * implements Cooper-Harvey-Kennedy + Cytron + Tarjan; reverse-post-order, the
 * loop-reachability check, and the def-set/lattice primitives are shared with
 * the dense GEN/KILL solver and the dispatcher.
 *
 * These are held byte-identical to their former inline form by the differential
 * equivalence fuzz (test/unit/cfg/reaching-defs-equivalence.test.ts) — any diff
 * after extraction is an extraction bug, never the oracle.
 */

/** def-site keys reaching a program point (see reaching-defs.ts). */
type DefSet = Set<number>;
/** bindingIdx → def-site keys (the dense solver's per-block lattice). */
type Lattice = Map<number, DefSet>;

/**
 * RPO over blocks reachable from `entry`; unreachable blocks appended by index.
 * Returns the order AND the reachability bitmap the DFS already computed, so a
 * caller needing "is every block reachable?" reuses this pass instead of a
 * separate BFS (#2201 review R8 — the SSA path's reachability gate).
 *
 * @internal
 */
export function reversePostOrder(
  entry: number,
  succs: readonly number[][],
  n: number,
): { order: number[]; visited: boolean[] } {
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
  return { order, visited };
}

/**
 * Immediate dominators (Cooper-Harvey-Kennedy; correct on irreducible CFGs).
 * `rpo` is the reverse-post-order rooted at the synthetic start `S`, `dPredsX`
 * the dominator-graph predecessors (incl. S→entry). Returns idom[b] for every
 * node in [0, nx); idom[S] === S.
 *
 * @internal
 */
export function buildDominators(
  rpo: readonly number[],
  dPredsX: readonly number[][],
  S: number,
  nx: number,
): number[] {
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
  return idom;
}

/**
 * Dominance frontiers (Cytron). df[b] is the set of nodes where b's dominance
 * ends — the φ-placement targets for any binding defined in b.
 *
 * @internal
 */
export function buildDominanceFrontiers(
  dPredsX: readonly number[][],
  idom: readonly number[],
  nx: number,
): Set<number>[] {
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
  return df;
}

/**
 * Tarjan strongly-connected components over the value-graph operand edges
 * (`nodeOps[node]` = operand node ids). Iterative (explicit work stack — the
 * graph can be deep). SCCs are emitted in REVERSE topological order, so an
 * SCC's operand SCCs are numbered before it — the property
 * {@link condenseReachingSets} relies on for its single forward pass.
 *
 * @internal
 */
export function tarjanScc(nodeOps: readonly number[][]): {
  sccOf: number[];
  sccMembers: number[][];
} {
  const N = nodeOps.length;
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
  return { sccOf, sccMembers };
}

/**
 * Reaching def-key set per SCC via condensation (cycle-safe union). Tarjan emits
 * SCCs in reverse topological order, so a single forward pass over SCCs resolves
 * every union: an SCC's reaching set is its members' own leaf keys plus the
 * already-computed reaching sets of its cross-SCC operands.
 *
 * Alias fast path (#2201 review R2): an SCC with NO own leaf keys whose cross-SCC
 * operands all resolve to a SINGLE source SCC has exactly that source's reaching
 * set — share it BY REFERENCE instead of copying element-by-element (the O(defs²)
 * cost at wide-fan-in φ merges). Safe: the returned sets are read-only after this
 * pass, and contents are identical (set iteration order is irrelevant — the
 * sweep sorts each use's keys before emission, KTD6).
 *
 * @internal
 */
export function condenseReachingSets(
  sccMembers: readonly number[][],
  sccOf: readonly number[],
  nodeKeys: readonly (DefSet | null)[],
  nodeOps: readonly number[][],
): DefSet[] {
  const reachByScc: DefSet[] = new Array(sccMembers.length);
  for (let s = 0; s < sccMembers.length; s++) {
    const members = sccMembers[s];
    let aliasTarget = -1; // the unique cross-SCC source SCC, or -1 if none/many
    let hasOwnKeys = false;
    let multiSource = false;
    for (const node of members) {
      if (nodeKeys[node]) {
        hasOwnKeys = true;
        break;
      }
      for (const w of nodeOps[node]) {
        const ws = sccOf[w];
        if (ws === s) continue; // intra-SCC operand: same set being built, adds nothing
        if (aliasTarget === -1) aliasTarget = ws;
        else if (aliasTarget !== ws) {
          multiSource = true;
          break;
        }
      }
      if (multiSource) break;
    }
    if (!hasOwnKeys && !multiSource && aliasTarget !== -1) {
      reachByScc[s] = reachByScc[aliasTarget]; // zero-copy share
      continue;
    }
    // General case: union own leaf keys + every distinct cross-SCC operand set.
    const set: DefSet = new Set();
    for (const node of members) {
      const keys = nodeKeys[node];
      if (keys) for (const k of keys) set.add(k);
      for (const w of nodeOps[node]) {
        const ws = sccOf[w];
        if (ws !== s) for (const k of reachByScc[ws]) set.add(k);
      }
    }
    reachByScc[s] = set;
  }
  return reachByScc;
}

/**
 * True iff a cycle is reachable from `entry` (the CFG has a loop). Iterative DFS
 * with a gray/black coloring; a gray successor is a back-edge. O(V+E). Used by
 * the production dispatcher to decide SSA-vs-dense.
 *
 * @internal
 */
export function hasReachableLoop(entry: number, succs: readonly number[][], n: number): boolean {
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
 * Order-stable union of two def-sets (shares `a` when `b` adds nothing).
 *
 * @internal
 */
export function unionSets(a: DefSet, b: DefSet): DefSet {
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

/**
 * Per-binding lattice equality with a reference fast path (sets only ever grow).
 *
 * @internal
 */
export function latticeEquals(a: Lattice, b: Lattice): boolean {
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
