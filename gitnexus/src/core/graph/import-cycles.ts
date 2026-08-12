/**
 * Elementary import-cycle enumeration.
 *
 * ## What is reported
 *
 * Every *elementary* cycle of the file-import graph — a closed walk that visits
 * no file twice — is reported exactly once. Self-imports (`a -> a`) and
 * two-file cycles count. Cycles that are nested inside, or that overlap with,
 * other cycles are each reported separately: a strongly connected component
 * with three mutually-importing files contributes five cycles, not one.
 *
 * This replaces an earlier implementation that returned ONE representative
 * cycle per cyclic strongly connected component. That made the reported count a
 * count of tangles, not of cycles, and it hid every cycle in a component but
 * the first — including cycles that a reader would have to break separately.
 * The tangle count is still available, as `componentCount`, under a name that
 * says what it is.
 *
 * The scale of what the old shape hid, measured on GitNexus itself (2,079
 * files, 5,320 initialization-forcing import edges): it reported 11 cycles.
 * There are 27,939, spread across those same 11 components. It showed 11 of
 * them and 27,928 were invisible.
 *
 * ## Algorithm
 *
 * Donald B. Johnson, "Finding all the elementary circuits of a directed graph",
 * SIAM J. Comput. 4(1), 1975 — SCC decomposition plus a backtracking search
 * guarded by the `blocked` flag and the `B` sets, which together guarantee that
 * no fruitless path is explored twice between two circuit outputs. That is what
 * buys the O((n + e)(c + 1)) bound for `c` circuits: the cost is proportional
 * to the answer, not to the size of the search space.
 *
 * SCCs come from an iterative Tarjan pass rather than the Kosaraju pass this
 * module used before. Johnson recomputes SCCs on each induced subgraph as the
 * root advances, and Tarjan needs only the forward adjacency, so nothing has to
 * rebuild a reverse graph once per root.
 *
 * ## How this differs from madge
 *
 * madge's `circular()` walks depth-first from every node carrying its ancestor
 * path and records `ancestors.slice(indexOf(dep))` whenever it reaches an
 * ancestor. It also marks nodes visited *globally* and skips them on later
 * walks, so once a node has been traversed, cycles reachable only by entering
 * it from a different predecessor are never seen. madge therefore reports many
 * cycles but not all of them, and which ones it misses depends on iteration
 * order. Johnson's is strictly stronger: it is complete.
 *
 * The practical consequence is that GitNexus reports MORE cycles than madge on
 * the same graph, and the two counts should not be expected to agree. Anyone
 * reconciling the two is not looking at a bug here.
 *
 * ## Determinism
 *
 * Adjacency lists and the node order are sorted (default string order, matching
 * `Array.prototype.sort`), the search visits neighbours in that order, and the
 * finished list is sorted element-wise. Same input, same output, byte for byte.
 *
 * ## Rotation normalization
 *
 * `[a, b, c, a]` and `[b, c, a, b]` are the same cycle and must be emitted
 * once. That is structural here rather than a post-hoc dedup pass: Johnson's
 * search for circuits rooted at `s` runs on the subgraph induced by the nodes
 * that sort at or after `s`, so every node of an emitted circuit sorts at or
 * after its root. Each cycle is therefore emitted exactly once, rooted at — and
 * closed back onto — its own lexicographically smallest node. No other rotation
 * of it can ever be produced.
 *
 * ## Bounds
 *
 * The number of elementary cycles is exponential in the worst case, so the
 * search is bounded twice: by the number of cycles (`IMPORT_CYCLE_LIMIT`) and
 * by the work spent finding them (`IMPORT_CYCLE_WORK_LIMIT`). The second is not
 * redundant — Johnson's is output-sensitive, so a graph that yields few cycles
 * per root can burn unbounded time while staying far under the cycle cap.
 *
 * Exceeding either bound abandons the enumeration. What a partial run had
 * accumulated is discarded rather than returned, because a partial list of
 * elementary cycles is indistinguishable from a complete one at the call site
 * and would be read as "these are all of them". What is returned instead is a
 * different KIND of list — one representative cycle per cyclic component, the
 * old pre-enumeration answer — under `enumeration: 'component-representatives'`
 * so the difference is machine-readable and not merely documented. Only a run
 * that dies inside the decomposition itself reports nothing at all.
 */

interface ImportEdge {
  source: string;
  target: string;
}

/**
 * Elementary cycles reported before the search fails closed.
 *
 * The binding constraint is response size, not time. THE MEASUREMENT THAT SETS
 * THIS NUMBER, on GitNexus itself — 2,079 files, 5,320 initialization-forcing
 * import edges: complete enumeration finds 27,939 elementary cycles across 11
 * components in 241ms. Fast. But those cycles average 13 files each, so
 * serializing them is 400,877 path entries — a 21.8 MB JSON response for a tool
 * whose result is read by an agent. Time was never going to stop that, and
 * neither was the work budget (the same run spends 6.3M of its 10M).
 *
 * Keep that measurement next to this constant. Without it the cap looks like an
 * arbitrary round number and gets raised or deleted by someone who has only
 * ever seen it not fire.
 *
 * So the cap is set where the answer stops being consumable rather than where
 * the machine stops coping. Past 10,000 cycles the ten-thousandth path tells a
 * reader nothing the first hundred did not, and what a reader acts on is
 * `componentCount` plus one cycle per component — which is exactly what a
 * report over the cap degrades to, rather than to nothing.
 */
export const IMPORT_CYCLE_LIMIT = 10_000;

/**
 * Units of search effort allowed before the search fails closed — edges
 * examined, nodes scanned per root, and emitted cycle nodes at
 * `EMITTED_NODE_COST` each — counted across the SCC passes and the circuit
 * search alike.
 *
 * The cycle cap alone does NOT bound this. Johnson's is output-sensitive at
 * O((n + e)(c + 1)), so producing `c` cycles still scales with the graph: a
 * component of mutually-importing neighbours yields one or two cycles per root,
 * so an SCC pass runs per node and the total is quadratic while the cycle count
 * stays low. `check` admits import graphs up to 100k edges, so that shape is
 * reachable, and there it is minutes of work under a cycle cap that never
 * trips. The reverse gap is just as real: a single 50k-file component produces
 * cycles 50k files long, and 10k of those exhaust the heap. One bound cannot
 * see both, which is why there are two.
 *
 * Measured on this implementation, worst case is ~7M units/second — the
 * mutual-import chain, where every unit of budget buys a fresh SCC pass over a
 * barely-smaller component. 10M is therefore ~1.5s of enumeration, and it sits
 * far above what real import graphs cost: a 100k-file acyclic graph spends
 * 0.3M, and 20k independent three-file tangles spend 1.1M. Only a component
 * both large and densely tangled reaches it, and that component's honest answer
 * is "too tangled to enumerate", not a silently-shortened list.
 */
export const IMPORT_CYCLE_WORK_LIMIT = 10_000_000;

/**
 * Work charged per node of an emitted cycle, relative to one edge examination.
 *
 * Emitted nodes are retained for the lifetime of the call and then sorted and
 * serialized, so they are the term that decides peak memory, while examined
 * edges cost nothing but time. Without a weight here, a graph whose cycles are
 * tens of thousands of files long exhausts the heap while both bounds still
 * read as comfortably unspent.
 */
const EMITTED_NODE_COST = 10;

/** Which bound stopped the search. */
export type ImportCycleLimit = 'cycles' | 'work';

/**
 * What a report's `cycles` list actually is.
 *
 * This is the union's discriminant rather than a sibling flag, deliberately: a
 * caller cannot reach `cycles` without first narrowing on what kind of list it
 * is holding. A partial enumeration and a complete one are indistinguishable by
 * inspection — both are arrays of real cycles — so the difference has to be
 * carried in the type, not in a comment or a count that happens to look small.
 */
export type ImportCycleEnumeration =
  /** Every elementary cycle in the graph. */
  | 'complete'
  /**
   * One cycle per cyclic component, and nothing about the rest. A bound was
   * hit, so the full enumeration was abandoned; what remains is the shortest
   * cycle through each component's least node — enough to name and locate every
   * tangle, and explicitly not a count of anything.
   */
  | 'component-representatives'
  /** No list at all: a bound was hit before even the decomposition finished. */
  | 'none';

export type ImportCycleReport =
  | {
      readonly enumeration: 'complete';
      /**
       * Every elementary cycle, each as `[n0, n1, ..., nk, n0]` — the first
       * node repeated at the end so the closing edge is explicit. Sorted.
       */
      readonly cycles: readonly string[][];
      /**
       * Number of cyclic strongly connected components — the count of
       * independent tangles. This is what the previous implementation called
       * the cycle count; it is NOT the number of cycles.
       */
      readonly componentCount: number;
    }
  | {
      /**
       * A bound was hit, so the enumeration is abandoned — but the SCC
       * decomposition had already finished, so every tangle is known and each
       * one gets a representative. This is strictly more useful than an error:
       * a CI job can act on "these 11 components are cyclic, here is one cycle
       * through each", and cannot act on nothing at all.
       *
       * What is NOT carried is any count of cycles. `componentCount` is exact;
       * the number of elementary cycles is unknown and stays unknown.
       */
      readonly enumeration: 'component-representatives';
      /** One cycle per component, same shape and ordering as the complete list. */
      readonly cycles: readonly string[][];
      readonly componentCount: number;
      readonly reason: ImportCycleLimit;
      readonly limit: number;
    }
  | {
      /**
       * A bound was hit inside the decomposition itself, so not even the tangle
       * count is known. There is genuinely nothing to report.
       */
      readonly enumeration: 'none';
      readonly reason: ImportCycleLimit;
      readonly limit: number;
    };

/** Sorted forward adjacency plus the set of nodes that import themselves. */
interface ImportGraph {
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  readonly nodes: readonly string[];
  readonly selfLoops: ReadonlySet<string>;
}

function buildGraph(edges: readonly ImportEdge[]): ImportGraph {
  const targetsBySource = new Map<string, Set<string>>();
  for (const { source, target } of edges) {
    if (!source || !target) continue;
    const targets = targetsBySource.get(source) ?? new Set<string>();
    targets.add(target);
    targetsBySource.set(source, targets);
    if (!targetsBySource.has(target)) targetsBySource.set(target, new Set());
  }

  const adjacency = new Map<string, readonly string[]>();
  const selfLoops = new Set<string>();
  for (const [source, targets] of targetsBySource) {
    adjacency.set(source, [...targets].sort());
    if (targets.has(source)) selfLoops.add(source);
  }
  return { adjacency, nodes: [...adjacency.keys()].sort(), selfLoops };
}

interface CircuitSearch {
  readonly cycles: string[][];
  readonly cycleLimit: number;
  readonly workLimit: number;
  /** Search effort so far, across the SCC passes and the circuit search alike. */
  work: number;
  /** Non-null once a bound is hit; every loop unwinds on it. */
  exceeded: ImportCycleLimit | null;
}

/**
 * Charge `amount` units of search effort. Returns true once the budget is
 * spent, which every caller must honour — a bulk charge that is not checked
 * would let the search run on past the bound it just crossed.
 */
function overBudget(search: CircuitSearch, amount = 1): boolean {
  search.work += amount;
  if (search.work <= search.workLimit) return false;
  search.exceeded = 'work';
  return true;
}

/**
 * Strongly connected components of the subgraph induced by `allowed`, via an
 * iterative Tarjan. Iterative because import graphs reach 10^5 files and a
 * recursive walk would blow the stack long before that.
 *
 * `roots` fixes the order the outer loop starts from, which is what makes the
 * component set — and so Johnson's choice of root — deterministic.
 *
 * Abandons the pass and returns a partial list if the work budget runs out, so
 * every caller must check `search.exceeded` before using the result.
 */
function stronglyConnectedComponents(
  roots: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  allowed: ReadonlySet<string>,
  search: CircuitSearch,
): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const pending: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  // One pass over the roots happens even for a component with no edges left.
  if (overBudget(search, roots.length)) return components;

  for (const root of roots) {
    if (search.exceeded !== null) break;
    if (index.has(root)) continue;
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    pending.push(root);
    onStack.add(root);
    const frames = [{ node: root, nextIndex: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.nextIndex < neighbors.length) {
        const next = neighbors[frame.nextIndex];
        frame.nextIndex += 1;
        if (overBudget(search)) return components;
        if (!allowed.has(next)) continue;
        if (!index.has(next)) {
          index.set(next, counter);
          lowLink.set(next, counter);
          counter += 1;
          pending.push(next);
          onStack.add(next);
          frames.push({ node: next, nextIndex: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, index.get(next)!));
        }
        continue;
      }

      frames.pop();
      const node = frame.node;
      if (lowLink.get(node)! === index.get(node)!) {
        const component: string[] = [];
        for (;;) {
          const member = pending.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === node) break;
        }
        components.push(component);
      }
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].node;
        lowLink.set(parent, Math.min(lowLink.get(parent)!, lowLink.get(node)!));
      }
    }
  }

  return components;
}

/** A component that contains at least one cycle: two-plus members, or a self-import. */
function isCyclic(component: readonly string[], selfLoops: ReadonlySet<string>): boolean {
  return component.length > 1 || selfLoops.has(component[0]);
}

function leastNode(nodes: readonly string[]): string {
  let least = nodes[0];
  for (const node of nodes) if (node < least) least = node;
  return least;
}

/** Order components by their least node. Components are disjoint, so this is total. */
function byLeastNode(left: readonly string[], right: readonly string[]): number {
  const leftLeast = leastNode(left);
  const rightLeast = leastNode(right);
  return leftLeast < rightLeast ? -1 : leftLeast > rightLeast ? 1 : 0;
}

/**
 * Johnson's `UNBLOCK`, iterative. Lifts `node` and everything transitively
 * waiting on it out of `blocked`, so a path that was abandoned as fruitless
 * becomes explorable again once the reason it was fruitless is gone.
 */
function unblock(node: string, blocked: Set<string>, blockedBy: Map<string, Set<string>>): void {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    blocked.delete(current);
    const waiting = blockedBy.get(current);
    if (waiting === undefined || waiting.size === 0) continue;
    for (const dependent of waiting) {
      if (blocked.has(dependent)) stack.push(dependent);
    }
    waiting.clear();
  }
}

/**
 * Johnson's `CIRCUIT`, iterative — enumerate the elementary circuits rooted at
 * `root` inside `allowed`.
 *
 * Every circuit found here starts and ends at `root`, and `root` is the least
 * node of `allowed` by construction, which is where the rotation guarantee in
 * the module docblock comes from.
 */
function enumerateCircuitsFrom(
  root: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  allowed: ReadonlySet<string>,
  search: CircuitSearch,
): void {
  const blocked = new Set<string>([root]);
  const blockedBy = new Map<string, Set<string>>();
  const path = [root];
  const frames = [{ node: root, nextIndex: 0, foundCircuit: false }];

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const neighbors = adjacency.get(frame.node) ?? [];

    if (search.exceeded === null && frame.nextIndex < neighbors.length) {
      const next = neighbors[frame.nextIndex];
      frame.nextIndex += 1;
      if (overBudget(search)) continue;
      if (!allowed.has(next)) continue;
      if (next === root) {
        // `path` is the elementary path root -> ... -> frame.node; closing it
        // back onto the root yields the cycle in the documented shape. A
        // self-import lands here on the first step with path === [root].
        search.cycles.push([...path, root]);
        frame.foundCircuit = true;
        // One-past, matching the edge-limit guard in `check`: `cycleLimit`
        // cycles is an acceptable answer, and it takes finding one MORE to
        // prove the graph overflowed. Stopping at `>= cycleLimit` would fail a
        // graph that has exactly that many cycles and could have been reported
        // in full.
        //
        // Tested before the emission charge so that a graph over both bounds
        // reports the cycle cap, which is the one a reader can act on, rather
        // than whichever happened to trip first.
        if (search.cycles.length > search.cycleLimit) {
          search.exceeded = 'cycles';
          continue;
        }
        // A found cycle is not merely traversed: it is copied, retained until
        // the call returns, sorted, and serialized into an MCP response. So it
        // is charged at EMITTED_NODE_COST per node, not 1. This is what bounds
        // MEMORY as well as time — 10,000 cycles is a modest cap when cycles
        // are four files long and a heap-exhausting one when a single strongly
        // connected component is 50,000 files around.
        overBudget(search, (path.length + 1) * EMITTED_NODE_COST);
        continue;
      }
      if (!blocked.has(next)) {
        blocked.add(next);
        path.push(next);
        frames.push({ node: next, nextIndex: 0, foundCircuit: false });
      }
      continue;
    }

    // Leaving `frame.node`. If it reached the root, it may lie on further
    // circuits, so it and its waiters go back in play. If it did not, it is
    // recorded as a dead end on each of its successors: it stays blocked until
    // one of them is unblocked, which is the pruning that makes Johnson's
    // output-sensitive rather than exponential in the graph size.
    frames.pop();
    path.pop();
    if (frame.foundCircuit) {
      unblock(frame.node, blocked, blockedBy);
    } else {
      for (const next of neighbors) {
        if (!allowed.has(next)) continue;
        const waiting = blockedBy.get(next) ?? new Set<string>();
        waiting.add(frame.node);
        blockedBy.set(next, waiting);
      }
    }
    if (frames.length > 0 && frame.foundCircuit) {
      frames[frames.length - 1].foundCircuit = true;
    }
  }
}

/**
 * Johnson's outer loop over one cyclic component: search the circuits rooted at
 * the component's least node, drop that node, and repeat on whatever cyclic
 * components the remainder falls into.
 *
 * Dropping the root is the whole rotation guarantee. Every cycle left after the
 * drop consists of nodes greater than every root taken so far, so when the
 * component holding it finally has that cycle's own minimum as its least node,
 * the cycle is emitted once, rooted there. No other rotation is reachable,
 * because the other rotations' starting nodes have already been excluded or are
 * not the component's least.
 *
 * Re-decomposing the REMAINDER rather than the original node range also keeps
 * each pass proportional to what is left: a tangle that falls apart when its
 * busiest file is removed stops costing anything immediately.
 */
function enumerateComponentCycles(
  component: readonly string[],
  graph: ImportGraph,
  search: CircuitSearch,
): void {
  // Components still to search. Pushed so that they pop in increasing order of
  // least node — see the sort below.
  const stack: string[][] = [[...component]];

  while (stack.length > 0 && search.exceeded === null) {
    const current = stack.pop()!;
    const root = leastNode(current);
    // Scanning for the root and materializing the allowed set both cost one
    // pass over the component, and both happen once per root, so they are the
    // O(n^2) term on a component that never splits. Charged, or the budget
    // would not see the work it exists to bound.
    if (overBudget(search, current.length)) return;
    enumerateCircuitsFrom(root, graph.adjacency, new Set(current), search);
    if (search.exceeded !== null) return;

    const remaining = current.filter((node) => node !== root);
    if (remaining.length === 0) continue;
    // Deliberately NOT re-sorted: the SCC set is independent of the order its
    // roots are visited in, `leastNode` picks Johnson's root regardless, and
    // the finished cycle list is sorted at the end. Sorting here would add an
    // O(n log n) term to every root for no observable difference.
    const subComponents = stronglyConnectedComponents(
      remaining,
      graph.adjacency,
      new Set(remaining),
      search,
    )
      .filter((subComponent) => isCyclic(subComponent, graph.selfLoops))
      .map((subComponent) => ({ least: leastNode(subComponent), nodes: subComponent }))
      // Descending, so the stack pops them in increasing order of least node —
      // Johnson's root order, and what makes a budget-stopped run stop at a
      // deterministic point rather than wherever iteration happened to be.
      .sort((a, b) => (a.least < b.least ? 1 : a.least > b.least ? -1 : 0));
    for (const subComponent of subComponents) stack.push(subComponent.nodes);
  }
}

/**
 * The shortest cycle through a component's least node, by breadth-first search
 * across the component.
 *
 * This is the fallback when a bound stops the full enumeration: one concrete,
 * checkable cycle naming each tangle. It is also exactly what this module
 * returned for every component before elementary enumeration existed, so the
 * degraded answer is no worse than the old complete answer.
 *
 * Linear in the component, and it runs only after the decomposition has already
 * succeeded, so it cannot fail the way the enumeration did. The budget is
 * charged for honesty — it is already spent at this point, and this work is not
 * optional, so the charge is accounting rather than a gate.
 */
function representativeCycle(
  component: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  search: CircuitSearch,
): string[] {
  const allowed = new Set(component);
  const start = leastNode(component);
  const parents = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  search.work += component.length;

  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    for (const next of adjacency.get(node) ?? []) {
      if (!allowed.has(next)) continue;
      search.work += 1;
      if (next === start) {
        const path: string[] = [];
        let cursor: string | null = node;
        while (cursor !== null) {
          path.push(cursor);
          cursor = parents.get(cursor) ?? null;
        }
        path.reverse();
        return [...path, start];
      }
      if (parents.has(next)) continue;
      parents.set(next, node);
      queue.push(next);
    }
  }

  // Unreachable: every component reaching here is cyclic, and BFS from its
  // least node inside the component must close. Thrown rather than returned
  // empty so a future change that breaks the invariant is loud.
  throw new Error('Invariant violation: no cycle found through cyclic component root.');
}

/** Element-wise lexicographic order, so the finished list is byte-stable. */
function compareCycles(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

/**
 * Enumerate every elementary cycle in the file import graph.
 *
 * Returns `status: 'limit_exceeded'` — carrying no cycles, only the tangle
 * count if it is known — when the search exceeds `cycleLimit` cycles or
 * `workLimit` units of effort. See the module docblock for the algorithm, the
 * rotation rule, and why overflow fails closed instead of returning a short
 * list.
 */
export function findImportCycles(
  edges: readonly ImportEdge[],
  cycleLimit: number = IMPORT_CYCLE_LIMIT,
  workLimit: number = IMPORT_CYCLE_WORK_LIMIT,
): ImportCycleReport {
  const graph = buildGraph(edges);
  const allNodes = new Set(graph.nodes);
  const search: CircuitSearch = { cycles: [], cycleLimit, workLimit, work: 0, exceeded: null };

  const decomposition = stronglyConnectedComponents(graph.nodes, graph.adjacency, allNodes, search);
  // Only a decomposition that ran to completion has a trustworthy count; one
  // abandoned mid-pass would undercount silently.
  const decompositionComplete = search.exceeded === null;
  const cyclicComponents = decomposition
    .filter((component) => isCyclic(component, graph.selfLoops))
    .sort(byLeastNode);

  for (const component of cyclicComponents) {
    if (search.exceeded !== null) break;
    enumerateComponentCycles(component, graph, search);
  }

  if (search.exceeded !== null) {
    const reason = search.exceeded;
    const limit = reason === 'cycles' ? cycleLimit : workLimit;
    if (!decompositionComplete) return { enumeration: 'none', reason, limit };
    // Whatever the abandoned enumeration accumulated is discarded — it is a
    // partial list of elementary cycles and would read as a complete one.
    // Representatives are a different KIND of list, one per component, and the
    // report says so in the type.
    return {
      enumeration: 'component-representatives',
      cycles: cyclicComponents
        .map((component) => representativeCycle(component, graph.adjacency, search))
        .sort(compareCycles),
      componentCount: cyclicComponents.length,
      reason,
      limit,
    };
  }
  return {
    enumeration: 'complete',
    cycles: search.cycles.sort(compareCycles),
    componentCount: cyclicComponents.length,
  };
}
