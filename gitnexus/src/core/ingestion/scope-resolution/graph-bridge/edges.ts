/**
 * Graph edge emission primitives.
 *
 * Two functions:
 *   - `mapReferenceKindToEdgeType` — translate a scope-resolution
 *     `Reference.kind` into the corresponding graph edge type.
 *   - `tryEmitEdge` — given a reference site + target def, resolve
 *     caller + target to graph ids and emit the edge with
 *     language-provided reason text, dedup-keyed by
 *     `(edgeType, callerId, targetId, line, col)`.
 *
 * Next-consumer contract: any language provider can call `tryEmitEdge`
 * from its own post-pass to emit edges it resolves Python-specific
 * (or TypeScript-specific, etc.) logic. The dedup key is
 * language-agnostic — no language needs to change it.
 */

import type { Reference, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { resolveCallerGraphId, resolveDefGraphId } from '../graph-bridge/ids.js';

/**
 * Map a `Reference.kind` to a graph edge type. `import-use` is dropped
 * (no edge type today — provenance lives on the IMPORTS edge emitted
 * by `emitImportEdges`).
 */
export function mapReferenceKindToEdgeType(
  kind: Reference['kind'],
): 'CALLS' | 'ACCESSES' | 'EXTENDS' | 'USES' | undefined {
  switch (kind) {
    case 'call':
      return 'CALLS';
    case 'read':
    case 'write':
      return 'ACCESSES';
    case 'inherits':
      return 'EXTENDS';
    case 'type-reference':
      return 'USES';
    case 'import-use':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Resolve caller + target to graph ids and emit the edge. Returns true
 * if the edge was emitted (not deduped, not skipped).
 *
 * `seen` is a language-shared dedup set keyed by
 * `${edgeType}:${callerGraphId}->${targetGraphId}:${line}:${col}` so
 * multiple language-specific post-passes can share it and never
 * double-emit a resolution one of them already produced.
 */
export function tryEmitEdge(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  site: {
    readonly inScope: ScopeId;
    readonly atRange: { startLine: number; startCol: number };
    readonly kind: string;
  },
  targetDef: SymbolDefinition,
  reason: string,
  seen: Set<string>,
  confidence = 0.85,
  collapseByCallerTarget = false,
): boolean {
  const callerGraphId = resolveCallerGraphId(site.inScope, scopes, nodeLookup);
  const targetGraphId = resolveDefGraphId(targetDef.filePath, targetDef, nodeLookup);
  const edgeType = mapReferenceKindToEdgeType(site.kind as Reference['kind']);
  if (callerGraphId === undefined) return false;
  if (targetGraphId === undefined) return false;
  if (edgeType === undefined) return false;

  // CALLS edges may collapse to `(caller, target)` granularity when
  // the provider opts in (C# matches legacy DAG behavior this way).
  // Write/read ACCESSES keep per-site dedup so multiple writes to the
  // same field on different lines produce distinct edges.
  const useCollapsed = collapseByCallerTarget && edgeType === 'CALLS';
  const dedupKey = useCollapsed
    ? `${edgeType}:${callerGraphId}->${targetGraphId}`
    : `${edgeType}:${callerGraphId}->${targetGraphId}:${site.atRange.startLine}:${site.atRange.startCol}`;
  if (seen.has(dedupKey)) return false;
  seen.add(dedupKey);

  graph.addRelationship({
    id: `rel:${dedupKey}`,
    sourceId: callerGraphId,
    targetId: targetGraphId,
    type: edgeType,
    confidence,
    reason,
  });
  return true;
}
