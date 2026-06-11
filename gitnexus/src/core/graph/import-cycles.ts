export interface ImportEdge {
  source: string;
  target: string;
}

function findCyclePath(component: string[], adjacency: Map<string, string[]>): string[] {
  const allowed = new Set(component);
  const start = component[0];
  const path = [start];
  const seen = new Set([start]);
  const stack = [{ node: start, nextIndex: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const neighbors = adjacency.get(frame.node) ?? [];
    if (frame.nextIndex >= neighbors.length) {
      stack.pop();
      path.pop();
      continue;
    }

    const next = neighbors[frame.nextIndex++];
    if (!allowed.has(next)) continue;
    if (next === start) return [...path, start];
    if (seen.has(next)) continue;
    seen.add(next);
    path.push(next);
    stack.push({ node: next, nextIndex: 0 });
  }

  return [...component, start];
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
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((component) => findCyclePath(component, sortedAdjacency));
}
