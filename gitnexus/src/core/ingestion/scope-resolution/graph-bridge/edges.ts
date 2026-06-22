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
import type { CalleeIdSink } from './callee-id-sink.js';

/**
 * Optional resolved-callee-id capture context (#2227 follow-up U2). Threaded
 * in only under `--pdg` (else `undefined` → zero overhead, byte-identity R4).
 * `filePath` is NOT on the `site` param, so it rides here alongside the sink.
 */
export interface CalleeIdCaptureCtx {
  readonly sink: CalleeIdSink;
  readonly filePath: string;
}

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
    // Macro invocations resolve to a `Macro` node (never a function), so
    // they emit `USES` — kept out of the `CALLS` keyspace which denotes
    // function/method dispatch (#1934 review).
    case 'macro':
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
  calleeCapture?: CalleeIdCaptureCtx,
): boolean {
  // Inheritance edges are emitted directly by `preEmitInheritanceEdges` (which
  // owns the enclosing-class caller and the EXTENDS-vs-IMPLEMENTS type), so this
  // generic bridge derives caller + edge type purely from the site.
  const callerGraphId = resolveCallerGraphId(site.inScope, scopes, nodeLookup, site.atRange);
  const targetGraphId = resolveDefGraphId(targetDef.filePath, targetDef, nodeLookup);
  const edgeType = mapReferenceKindToEdgeType(site.kind as Reference['kind']);
  if (callerGraphId === undefined) return false;
  if (targetGraphId === undefined) return false;
  if (edgeType === undefined) return false;

  // Resolved-callee-id capture (#2227 U2/KTD6/R8): record this CALLS site's
  // resolved target BEFORE the dedup `seen` check, so collapsed same-target
  // multi-line calls are still captured per site. Keyed on `site.atRange`
  // (1-based line / 0-based col — byte-equal to U1's SiteRecord.at).
  if (calleeCapture !== undefined && edgeType === 'CALLS') {
    calleeCapture.sink.add(
      calleeCapture.filePath,
      site.atRange.startLine,
      site.atRange.startCol,
      targetGraphId,
    );
  }

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

/**
 * Variant of `tryEmitEdge` that takes a pre-resolved target graph id
 * instead of resolving it from a `SymbolDefinition`. Used by the
 * value-receiver-owner bridge (`receiver-bound-calls.ts` Case 5) where
 * the picked owner-indexed method def carries no `qualifiedName` (object
 * literals have no class owner to seed it) and therefore cannot
 * round-trip through `resolveDefGraphId`. The def's `nodeId` IS the
 * canonical graph node id (written by the parse phase), so the caller
 * passes it directly.
 *
 * All other invariants of `tryEmitEdge` apply: dedup key shape, collapse
 * flag honoring, edge-type mapping, caller-id resolution.
 */
export function tryEmitEdgeWithExplicitTargetId(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  site: {
    readonly inScope: ScopeId;
    readonly atRange: { startLine: number; startCol: number };
    readonly kind: string;
  },
  targetGraphId: string,
  reason: string,
  seen: Set<string>,
  confidence = 0.85,
  collapseByCallerTarget = false,
  calleeCapture?: CalleeIdCaptureCtx,
): boolean {
  const callerGraphId = resolveCallerGraphId(site.inScope, scopes, nodeLookup, site.atRange);
  const edgeType = mapReferenceKindToEdgeType(site.kind as Reference['kind']);
  if (callerGraphId === undefined) return false;
  if (edgeType === undefined) return false;

  // Resolved-callee-id capture (#2227 U2/KTD6/R8) — before dedup, see
  // `tryEmitEdge`. The explicit target id IS the resolved callee id.
  if (calleeCapture !== undefined && edgeType === 'CALLS') {
    calleeCapture.sink.add(
      calleeCapture.filePath,
      site.atRange.startLine,
      site.atRange.startCol,
      targetGraphId,
    );
  }

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
