/**
 * Phase 5 of the RFC #909 ingestion lifecycle: drain `ReferenceIndex`
 * into the knowledge graph as labeled edges with `confidence` and
 * `evidence` properties (Ring 2 PKG #925).
 *
 * The resolution phase (future PR) writes `Reference` records into
 * `model.scopes.referenceSites`-derived `ReferenceIndex`; this module
 * materializes those records as `GraphRelationship`s via
 * `graph.addRelationship`. Every emitted edge carries:
 *
 *   - `type`: one of `'CALLS' | 'ACCESSES' | 'INHERITS' | 'USES'`
 *     (mapped from `Reference.kind` — `'read'` and `'write'` both route
 *     to `ACCESSES`; `'type-reference'` and `'import-use'` route to
 *     `USES`; `'call'` stays `CALLS`; `'inherits'` stays `INHERITS`).
 *   - `confidence`: the pre-computed confidence from the Reference record.
 *   - `reason`: human-readable summary (`"scope-resolution: call | confidence 0.75"`).
 *   - `evidence`: the full `ResolutionEvidence[]` trace — additive graph
 *     property (see `GraphRelationship.evidence` in gitnexus-shared),
 *     so queries that don't know about it are unaffected.
 *   - `step`: carries the reference's access-kind discriminant when
 *     available (`1` for read, `2` for write) so `ACCESSES` edges retain
 *     the read/write distinction without forcing a new edge type.
 *
 * ## Optional scope-tree flush
 *
 * When `INGESTION_EMIT_SCOPES=1` is set, this module also emits:
 *
 *   - `Scope` nodes for every `Scope` in the tree
 *   - `CONTAINS` edges from parent scope to child scope
 *   - `DEFINES` edges from scope to its `ownedDefs` members
 *   - `IMPORTS` edges from scope to `targetModuleScope` of each finalized
 *     `ImportEdge` that carries one
 *
 * Off by default — existing queries that don't know about `Scope` nodes
 * continue to work, and the storage cost is opt-in.
 *
 * ## Source-of-truth: the caller def for a reference
 *
 * A `Reference` says "some code inside `fromScope` references `toDef`".
 * The graph wants `(callerNodeId, calleeNodeId)`. We resolve the caller
 * by walking up the scope tree from `fromScope` until we find a scope
 * whose `ownedDefs` contains a Function-like def. If no such ancestor
 * exists, the edge is attributed to the first def owned by the innermost
 * ancestor scope, and if THAT produces nothing either the edge is
 * skipped (with a count returned in `EmitStats.skippedNoCaller`).
 */

import type {
  NodeLabel,
  RelationshipType,
  Reference,
  ReferenceIndex,
  ResolutionEvidence,
  Scope,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import type { ScopeResolutionIndexes } from './model/scope-resolution-indexes.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EmitStats {
  readonly edgesEmitted: number;
  /** References dropped because no caller def could be resolved. */
  readonly skippedNoCaller: number;
  /** References dropped because `toDef` was not found in the DefIndex. */
  readonly skippedMissingTarget: number;
  /** Scope nodes emitted — `0` unless `INGESTION_EMIT_SCOPES=1`. */
  readonly scopeNodesEmitted: number;
  /** Scope-tree structural edges emitted — `0` unless `INGESTION_EMIT_SCOPES=1`. */
  readonly scopeEdgesEmitted: number;
}

export interface EmitReferencesInput {
  readonly graph: KnowledgeGraph;
  readonly scopes: ScopeResolutionIndexes;
  readonly referenceIndex: ReferenceIndex;
  /** Human-consumable label for the `reason` prefix. Defaults to `'scope-resolution'`. */
  readonly sourceLabel?: string;
}

/**
 * Drain `referenceIndex.bySourceScope` into graph edges.
 *
 * The scope-tree flush is controlled separately by
 * `INGESTION_EMIT_SCOPES` — callers can run `emitReferencesToGraph`
 * without scope-node emission or layer the two calls as needed.
 */
export function emitReferencesToGraph(input: EmitReferencesInput): EmitStats {
  const { graph, scopes, referenceIndex } = input;
  const sourceLabel = input.sourceLabel ?? 'scope-resolution';

  let edgesEmitted = 0;
  let skippedNoCaller = 0;
  let skippedMissingTarget = 0;

  for (const [fromScope, refs] of referenceIndex.bySourceScope) {
    for (const ref of refs) {
      const targetDef = scopes.defs.get(ref.toDef);
      if (targetDef === undefined) {
        skippedMissingTarget++;
        continue;
      }
      const callerId = resolveCallerNodeId(fromScope, scopes);
      if (callerId === undefined) {
        skippedNoCaller++;
        continue;
      }
      graph.addRelationship(buildRelationship(ref, callerId, targetDef, sourceLabel));
      edgesEmitted++;
    }
  }

  const scopeStats = isScopeEmissionEnabled()
    ? emitScopeGraph({ graph, scopes })
    : { scopeNodesEmitted: 0, scopeEdgesEmitted: 0 };

  return { edgesEmitted, skippedNoCaller, skippedMissingTarget, ...scopeStats };
}

/**
 * Emit `Scope` nodes + `CONTAINS`/`DEFINES`/`IMPORTS` edges representing
 * the lexical scope tree itself. Skipped unless `INGESTION_EMIT_SCOPES=1`
 * at the public entry point; exported here for tests that want to
 * exercise the path directly.
 */
export function emitScopeGraph(input: {
  readonly graph: KnowledgeGraph;
  readonly scopes: ScopeResolutionIndexes;
}): { readonly scopeNodesEmitted: number; readonly scopeEdgesEmitted: number } {
  const { graph, scopes } = input;
  let scopeNodesEmitted = 0;
  let scopeEdgesEmitted = 0;

  for (const scope of scopes.scopeTree.byId.values()) {
    graph.addNode({
      id: scope.id,
      label: 'CodeElement' as NodeLabel, // the generic bucket for non-symbol graph nodes
      properties: {
        name: scope.kind,
        filePath: scope.filePath,
        startLine: scope.range.startLine,
        endLine: scope.range.endLine,
        description: `Scope: ${scope.kind}`,
      } as unknown as Parameters<KnowledgeGraph['addNode']>[0]['properties'],
    });
    scopeNodesEmitted++;

    if (scope.parent !== null) {
      graph.addRelationship({
        id: `rel:contains:${scope.parent}->${scope.id}`,
        sourceId: scope.parent,
        targetId: scope.id,
        type: 'CONTAINS',
        confidence: 1,
        reason: 'scope-tree parent/child',
      });
      scopeEdgesEmitted++;
    }

    for (const def of scope.ownedDefs) {
      graph.addRelationship({
        id: `rel:defines:${scope.id}->${def.nodeId}`,
        sourceId: scope.id,
        targetId: def.nodeId,
        type: 'DEFINES',
        confidence: 1,
        reason: 'scope.ownedDefs',
      });
      scopeEdgesEmitted++;
    }
  }

  for (const [scopeId, edges] of scopes.imports) {
    for (const edge of edges) {
      if (edge.targetModuleScope === undefined) continue;
      graph.addRelationship({
        id: `rel:imports:${scopeId}->${edge.targetModuleScope}:${edge.localName}`,
        sourceId: scopeId,
        targetId: edge.targetModuleScope,
        type: 'IMPORTS',
        confidence: edge.linkStatus === 'unresolved' ? 0.5 : 1,
        reason: `import ${edge.kind} ${edge.localName}`,
      });
      scopeEdgesEmitted++;
    }
  }

  return { scopeNodesEmitted, scopeEdgesEmitted };
}

// ─── Internal ───────────────────────────────────────────────────────────────

/** Accepted truthy values for `INGESTION_EMIT_SCOPES`. */
const TRUTHY: ReadonlySet<string> = new Set(['true', '1', 'yes']);

function isScopeEmissionEnabled(): boolean {
  const raw = process.env['INGESTION_EMIT_SCOPES'];
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Walk up from `startScope` looking for the first ancestor scope whose
 * `ownedDefs` contains a Function-like def (Function / Method /
 * Constructor). Fall back to the innermost ancestor's first `ownedDef`
 * if none is found; return `undefined` if all ancestors have no defs.
 */
function resolveCallerNodeId(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): string | undefined {
  const tree = scopes.scopeTree;
  let current: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  let firstOwnedFallback: string | undefined;

  while (current !== null) {
    if (visited.has(current)) break;
    visited.add(current);

    const scope: Scope | undefined = tree.getScope(current);
    if (scope === undefined) break;

    // Prefer a Function-like owner.
    const fnDef = scope.ownedDefs.find((d) => isFunctionLike(d.type));
    if (fnDef !== undefined) return fnDef.nodeId;

    // Stash the first owned def we see as a conservative fallback.
    if (firstOwnedFallback === undefined && scope.ownedDefs.length > 0) {
      firstOwnedFallback = scope.ownedDefs[0]!.nodeId;
    }

    current = scope.parent;
  }

  return firstOwnedFallback;
}

function isFunctionLike(type: NodeLabel): boolean {
  return type === 'Function' || type === 'Method' || type === 'Constructor';
}

function buildRelationship(
  ref: Reference,
  callerId: string,
  targetDef: SymbolDefinition,
  sourceLabel: string,
): Parameters<KnowledgeGraph['addRelationship']>[0] {
  const type = mapKindToType(ref.kind);
  const reason = `${sourceLabel}: ${ref.kind} | confidence ${ref.confidence.toFixed(3)}`;
  // `step` encodes read/write discriminator for ACCESSES edges (1=read, 2=write).
  // Other kinds omit `step`.
  const step = ref.kind === 'read' ? 1 : ref.kind === 'write' ? 2 : undefined;
  return {
    id: `rel:${type}:${callerId}->${targetDef.nodeId}:${ref.atRange.startLine}:${ref.atRange.startCol}`,
    sourceId: callerId,
    targetId: targetDef.nodeId,
    type,
    confidence: ref.confidence,
    reason,
    evidence: ref.evidence.map(serializeEvidence),
    ...(step !== undefined ? { step } : {}),
  };
}

/**
 * Map a `Reference.kind` to an existing `RelationshipType`. Read/write
 * both fold into `ACCESSES`; `type-reference` + `import-use` both fold
 * into `USES`. This keeps the graph schema additive — no new
 * RelationshipType values are introduced by this module.
 */
function mapKindToType(kind: Reference['kind']): RelationshipType {
  switch (kind) {
    case 'call':
      return 'CALLS';
    case 'read':
    case 'write':
      return 'ACCESSES';
    case 'inherits':
      return 'INHERITS';
    case 'type-reference':
    case 'import-use':
      return 'USES';
  }
}

function serializeEvidence(e: ResolutionEvidence): {
  readonly kind: string;
  readonly weight: number;
  readonly note?: string;
} {
  return {
    kind: e.kind,
    weight: e.weight,
    ...(e.note !== undefined ? { note: e.note } : {}),
  };
}
