/**
 * Generic MRO (method-resolution-order) builder.
 *
 * Walks the graph's `EXTENDS` edges to recover an inheritance map,
 * then asks the per-language `LinearizeStrategy` to order each class's
 * ancestors. Returns `Map<classDefId, ancestorDefId[]>` ready to plug
 * into `MethodDispatchIndex` via `buildPopulatedMethodDispatch`.
 *
 * **Why a strategy hook:** linearization differs across languages.
 *   - Python (depth-first first-seen, single inheritance): trivially
 *     correct; multi-inheritance falls back to BFS dedup. Real C3
 *     would handle diamond hierarchies — defer until we hit one.
 *   - Java (single-inheritance only): walk one parent.
 *   - C++ (multiple inheritance): C3-like or BFS depending on how
 *     strict the consumer needs to be.
 *   - Languages without inheritance (COBOL): return empty list.
 *
 * The strategy receives the FULL ancestry context (`directParents` +
 * `parentsByDefId`) so C3 implementations have what they need.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { LinearizeStrategy } from '../contract/scope-resolver.js';
import { resolveDefGraphId } from '../graph-bridge/ids.js';

/**
 * Build an MRO map keyed by scope-resolution Class `DefId`.
 *
 * Steps:
 *   1. Collect EXTENDS edges from the graph → `parentsByGraphId`.
 *   2. Collect Class defs from `parsedFiles` and translate to graph
 *      ids via `nodeLookup` → `defIdByGraphId` (the bridge between
 *      scope-resolution DefId and the legacy graph node id).
 *   3. For each Class def, ask `linearize` for its ancestor order.
 */
export function buildMro(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  linearize: LinearizeStrategy,
): Map<string /* DefId */, string[] /* DefId[] */> {
  // Step 1: parentsByGraphId — typed iterator skips the per-edge type
  // check and the millions of CALLS/ACCESSES/IMPORTS/DEFINES edges
  // that aren't relevant to MRO.
  const parentsByGraphId = new Map<string, string[]>();
  for (const rel of graph.iterRelationshipsByType('EXTENDS')) {
    let list = parentsByGraphId.get(rel.sourceId);
    if (list === undefined) {
      list = [];
      parentsByGraphId.set(rel.sourceId, list);
    }
    list.push(rel.targetId);
  }

  // Step 2: defIdByGraphId — translate graph ids to scope-resolution DefIds.
  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class') continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  // Step 2b: invert parentsByGraphId into parentsByDefId — the
  // strategy works in DefId space.
  const parentsByDefId = new Map<string, string[]>();
  for (const [childGraphId, parents] of parentsByGraphId) {
    const childDefId = defIdByGraphId.get(childGraphId);
    if (childDefId === undefined) continue;
    const parentDefIds: string[] = [];
    for (const p of parents) {
      const pd = defIdByGraphId.get(p);
      if (pd !== undefined) parentDefIds.push(pd);
    }
    parentsByDefId.set(childDefId, parentDefIds);
  }

  // Step 3: linearize per class.
  const mroByDefId = new Map<string, string[]>();
  for (const defId of defIdByGraphId.values()) {
    const directParents = parentsByDefId.get(defId) ?? [];
    mroByDefId.set(defId, linearize(defId, directParents, parentsByDefId));
  }
  return mroByDefId;
}

/**
 * Default linearization: depth-first BFS-with-visited, first-seen
 * wins. Correct for single-inheritance languages and for Python's
 * simplified MRO. Multi-inheritance diamond hierarchies need a real
 * C3 implementation; per-language overrides land here.
 */
export const defaultLinearize: LinearizeStrategy = (_classDefId, directParents, parentsByDefId) => {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [...directParents];
  for (;;) {
    const cur = queue.shift();
    if (cur === undefined) break;
    if (visited.has(cur)) continue;
    visited.add(cur);
    ancestors.push(cur);
    for (const p of parentsByDefId.get(cur) ?? []) queue.push(p);
  }
  return ancestors;
};
