interface ImportEdge {
  source: string;
  target: string;
}

function findCyclePath(component: string[], adjacency: Map<string, string[]>): string[] {
  const allowed = new Set(component);
  const start = component[0];
  const parents = new Map<string, string | null>([[start, null]]);
  const queue = [start];

  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    for (const next of adjacency.get(node) ?? []) {
      if (!allowed.has(next)) continue;
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

  throw new Error('Invariant violation: no cycle found through SCC root.');
}

/**
 * Return one deterministic concrete cycle for every cyclic strongly connected
 * component in the file import graph.
 */
export function findImportCycles(edges: ImportEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const { source, target } of edges) {
    if (!source || !target) continue;
    const targets = adjacency.get(source) ?? new Set<string>();
    targets.add(target);
    adjacency.set(source, targets);
    if (!adjacency.has(target)) adjacency.set(target, new Set());
  }

  const sortedAdjacency = new Map(
    [...adjacency].map(([node, targets]) => [node, [...targets].sort()] as const),
  );
  const reverseAdjacency = new Map<string, string[]>();
  for (const node of sortedAdjacency.keys()) reverseAdjacency.set(node, []);
  for (const [source, targets] of sortedAdjacency) {
    for (const target of targets) reverseAdjacency.get(target)!.push(source);
  }
  for (const sources of reverseAdjacency.values()) sources.sort();

  const visited = new Set<string>();
  const finishOrder: string[] = [];
  const components: string[][] = [];

  for (const start of [...sortedAdjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [{ node: start, nextIndex: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = sortedAdjacency.get(frame.node) ?? [];
      if (frame.nextIndex < neighbors.length) {
        const next = neighbors[frame.nextIndex++];
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ node: next, nextIndex: 0 });
        }
      } else {
        finishOrder.push(frame.node);
        stack.pop();
      }
    }
  }

  visited.clear();
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const start = finishOrder[index];
    if (visited.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      for (const next of reverseAdjacency.get(node) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    component.sort();
    components.push(component);
  }

  return components
    .filter(
      (component) =>
        component.length > 1 || (sortedAdjacency.get(component[0]) ?? []).includes(component[0]),
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((component) => findCyclePath(component, sortedAdjacency));
}
