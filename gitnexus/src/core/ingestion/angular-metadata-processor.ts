/**
 * Angular @NgModule Metadata Processor (#32)
 *
 * Fast-path: resolve pre-extracted NgModule metadata edges from the worker
 * into the graph. Mirrors the heritage-processor pattern:
 *   - resolve moduleClassName → Class node id (symbol-table first, fallback
 *     to a generated id when the class isn't yet registered)
 *   - resolve targetName → same strategy
 *   - emit the edge with confidence = geometric mean of both resolutions
 *   - skip self-edges
 *
 * Unlike heritage, target references (declarations / providers / etc.) can
 * be Classes OR Module references (BrowserModule is a Module, not a Class).
 * We use 'Class' as the primary fallback label because most references are
 * classes; unresolved module-references still get a stable synthetic id.
 */

import { KnowledgeGraph, type RelationshipType } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';
import { createResolutionContext, type ResolutionContext } from './resolution-context.js';
import { TIER_CONFIDENCE } from './resolution-context.js';
import { ANGULAR_EDGE_TYPES, type ExtractedAngularEdge, type AngularEdgeType } from './extractors/angular-metadata.js';

/**
 * Resolve a class/module name to a node id + confidence.
 * Reuses the heritage-processor resolution strategy — symbol-table first,
 * generated-id fallback for unresolved references.
 */
interface ResolvedTarget {
  readonly id: string;
  readonly confidence: number;
}

const resolveName = (
  name: string,
  filePath: string,
  ctx: ResolutionContext,
  fallbackLabel: 'Class' | 'Module',
): ResolvedTarget => {
  const resolved = ctx.resolve(name, filePath);
  if (resolved && resolved.candidates.length > 0) {
    // For global with multiple candidates, use the first (same as heritage).
    return { id: resolved.candidates[0].nodeId, confidence: TIER_CONFIDENCE[resolved.tier] };
  }
  // Unresolved: synthetic id with global-tier confidence
  return { id: generateId(fallbackLabel, `${filePath}:${name}`), confidence: TIER_CONFIDENCE['global'] };
};

/**
 * Maps each Angular edge type to its canonical RelationshipType. This is a
 * typed lookup — keyed by the AngularEdgeType const tuple — so we can convert
 * from the extractor's narrowed string union to the graph's RelationshipType
 * union without an `as any` escape hatch.
 */
const REL_TYPE_MAP: Record<typeof ANGULAR_EDGE_TYPES[number], RelationshipType> = {
  DECLARES: 'DECLARES',
  IMPORTS_MODULE: 'IMPORTS_MODULE',
  PROVIDES: 'PROVIDES',
  BOOTSTRAPS: 'BOOTSTRAPS',
};

/**
 * Process pre-extracted Angular @NgModule metadata edges and emit them
 * into the graph.
 *
 * @param graph       target knowledge graph
 * @param edges       pre-extracted edge records from the worker
 * @param ctx         resolution context (symbol table + import map)
 */
export const processAngularMetadataFromExtracted = async (
  graph: KnowledgeGraph,
  edges: ExtractedAngularEdge[],
  ctx: ResolutionContext,
  onProgress?: (current: number, total: number) => void,
): Promise<void> => {
  const total = edges.length;
  for (let i = 0; i < edges.length; i++) {
    if (i % 500 === 0) {
      onProgress?.(i, total);
      await new Promise(resolve => setImmediate(resolve));
    }

    const edge = edges[i];

    // IMPORTS_MODULE references Modules (e.g. BrowserModule) — but the
    // symbol table may have it as a Class (Angular modules are decorated
    // with @NgModule, which is a class). Try Class first, then Module.
    const source = resolveName(edge.moduleClassName, edge.filePath, ctx, 'Class');

    // Bootstrap/declaration/provider references are typically classes.
    // IMPORTS_MODULE entries may be classes (e.g. SharedModule) or
    // external identifiers; we default to Class for the same reason.
    const target = resolveName(edge.targetName, edge.filePath, ctx, 'Class');

    if (source.id === target.id) continue; // self-edge skip

    const relType = REL_TYPE_MAP[edge.edgeType];
    graph.addRelationship({
      id: generateId(relType, `${source.id}->${target.id}:${edge.edgeType}`),
      sourceId: source.id,
      targetId: target.id,
      type: relType,
      confidence: Math.sqrt(source.confidence * target.confidence),
      reason: `ng-module-${edge.edgeType.toLowerCase()}`,
      source: 'heuristic',
    });
  }
  onProgress?.(total, total);
};

// Re-export ResolutionContext for callers that import from this module
export { createResolutionContext };
export type { ResolutionContext };
export type { ExtractedAngularEdge, AngularEdgeType };
