/**
 * Generic MRO (method-resolution-order) builder.
 *
 * Walks the graph's `EXTENDS` edges to recover an inheritance map,
 * then asks the per-language `LinearizeStrategy` to order each class's
 * ancestors. Returns `Map<classDefId, ancestorDefId[]>` ready to plug
 * into `MethodDispatchIndex` via `buildPopulatedMethodDispatch`.
 *
 * **Why a strategy hook:** linearization differs across languages.
 *   - Python: C3 (`c3LinearizeStrategy`), the order CPython binds.
 *     Single inheritance matches the BFS walk. A diamond does not.
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
import { c3Linearize } from '../../model/resolve.js';
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
      if (!isClassLike(def.type)) continue;
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
 * Default linearization: breadth-first, first-seen wins. Correct for
 * single inheritance. A diamond visits a direct base before the deeper
 * base C3 would rank first. Python does not use this.
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

/**
 * CPython C3 order, excluding the class itself.
 *
 * The parent map and merge cache are reused for every class in one
 * `buildMro` call. An inconsistent or cyclic hierarchy has no CPython
 * order; those classes get an empty ancestor list rather than a
 * breadth-first order that would name the wrong method.
 */
const c3SlotByParents = new WeakMap<
  ReadonlyMap<string, readonly string[]>,
  { parentMap: Map<string, string[]>; cache: Map<string, string[] | null> }
>();

export const c3LinearizeStrategy: LinearizeStrategy = (
  classDefId,
  directParents,
  parentsByDefId,
) => {
  let slot = c3SlotByParents.get(parentsByDefId);
  if (slot === undefined) {
    const parentMap = new Map<string, string[]>();
    for (const [id, parents] of parentsByDefId) parentMap.set(id, [...parents]);
    slot = { parentMap, cache: new Map() };
    c3SlotByParents.set(parentsByDefId, slot);
  }
  if (!slot.parentMap.has(classDefId)) {
    slot.parentMap.set(classDefId, [...directParents]);
  }
  const linearized = c3Linearize(classDefId, slot.parentMap, slot.cache);
  return linearized ?? [];
};
