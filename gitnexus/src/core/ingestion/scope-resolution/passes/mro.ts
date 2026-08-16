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

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { LinearizeStrategy } from '../contract/scope-resolver.js';
import { resolveDefGraphId } from '../graph-bridge/ids.js';
import { isClassLike } from '../scope/walkers.js';

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
  options: {
    /** Include IMPLEMENTS parents only for owners explicitly accepted here.
     * The default keeps the historical EXTENDS-only MRO byte-identical. */
    readonly includeImplementsFor?: (owner: SymbolDefinition) => boolean;
  } = {},
): Map<string /* DefId */, string[] /* DefId[] */> {
  // Step 1: translate graph ids to scope-resolution DefIds.
  const defIdByGraphId = new Map<string, string>();
  const defByGraphId = new Map<string, SymbolDefinition>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) {
        defIdByGraphId.set(graphId, def.nodeId);
        defByGraphId.set(graphId, def);
      }
    }
  }

  // Step 2: collect accepted heritage edges directly in DefId space. The
  // optional IMPLEMENTS route is provider-gated so every existing caller keeps
  // the exact EXTENDS-only behavior.
  const parentsByDefId = new Map<string, string[]>();
  const seenParentsByDefId = new Map<string, Set<string>>();
  const addRelationships = (
    relationships: Iterable<{ readonly sourceId: string; readonly targetId: string }>,
    includeOwner?: (owner: SymbolDefinition) => boolean,
  ): void => {
    for (const relationship of relationships) {
      const owner = defByGraphId.get(relationship.sourceId);
      if (owner === undefined || (includeOwner !== undefined && !includeOwner(owner))) continue;
      const parentDefId = defIdByGraphId.get(relationship.targetId);
      if (parentDefId === undefined) continue;
      let parents = parentsByDefId.get(owner.nodeId);
      if (parents === undefined) {
        parents = [];
        parentsByDefId.set(owner.nodeId, parents);
      }
      let seenParents = seenParentsByDefId.get(owner.nodeId);
      if (seenParents === undefined) {
        seenParents = new Set();
        seenParentsByDefId.set(owner.nodeId, seenParents);
      }
      if (seenParents.has(parentDefId)) continue;
      seenParents.add(parentDefId);
      parents.push(parentDefId);
    }
  };
  addRelationships(graph.iterRelationshipsByType('EXTENDS'));
  if (options.includeImplementsFor !== undefined) {
    addRelationships(graph.iterRelationshipsByType('IMPLEMENTS'), options.includeImplementsFor);
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
