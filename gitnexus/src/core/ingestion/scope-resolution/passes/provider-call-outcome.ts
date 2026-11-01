import type { ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ReceiverMemberResolution } from '../contract/scope-resolver.js';
import { resolveCallerGraphId, resolveDefGraphId } from '../graph-bridge/ids.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { ResolutionOutcome } from '../resolution-outcome.js';

/** A nested call and its consumer can share a start position. Keep the entire
 * AST call range so compile-time return types cannot alias those calls. */
export function selectedCallKey(filePath: string, range: ReferenceSite['atRange']): string {
  return `${filePath}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
}

export function callResultBindingKey(scopeId: string, name: string): string {
  return `${scopeId}\0${name}`;
}

export interface CallOutcomeContext {
  readonly graph: KnowledgeGraph;
  readonly scopes: ScopeResolutionIndexes;
  readonly nodeLookup: GraphNodeLookup;
  readonly model: SemanticModel;
}

/** Preserve scope IDs for diagnostics while bridging to queryable graph IDs.
 * A failed bridge is missing evidence, never a measured empty candidate set. */
export function callSuppressionIdentities(
  candidateIds: readonly string[],
  site: ReferenceSite,
  context: CallOutcomeContext,
  inventoryComplete = true,
  definitions: readonly SymbolDefinition[] = [],
): Pick<
  Extract<ResolutionOutcome, { kind: 'suppressed' }>,
  'candidateGraphIds' | 'candidateOwnerIds' | 'callerId' | 'candidateSetComplete' | 'siteKind'
> {
  const { graph, scopes, nodeLookup, model } = context;
  const ids = [...new Set(candidateIds)];
  const candidateGraphIds = new Set<string>();
  const candidateOwnerIds = new Set<string>();
  let candidateSetComplete = inventoryComplete;
  let suppliedById: Map<string, SymbolDefinition> | undefined;
  let byId: Map<string, SymbolDefinition> | undefined;
  for (const id of ids) {
    let definition = scopes.defs.get(id);
    if (definition === undefined) {
      if (suppliedById === undefined) {
        suppliedById = new Map();
        for (const item of definitions) {
          if (!suppliedById.has(item.nodeId)) suppliedById.set(item.nodeId, item);
        }
      }
      definition = suppliedById.get(id);
    }
    if (definition === undefined) {
      byId ??= new Map(
        [
          ...model.methods.lookupMethodByName(site.name),
          ...model.symbols.lookupCallableByName(site.name),
        ].map((item) => [item.nodeId, item]),
      );
      definition = byId.get(id);
    }
    const graphId =
      definition === undefined
        ? graph.getNode(id)?.id
        : resolveDefGraphId(definition.filePath, definition, nodeLookup);
    if (graphId === undefined || graph.getNode(graphId) === undefined) {
      candidateSetComplete = false;
      continue;
    }
    candidateGraphIds.add(graphId);
    const ownerId = definition?.ownerId;
    if (ownerId !== undefined) {
      const owner = scopes.defs.get(ownerId);
      const ownerGraphId =
        owner === undefined
          ? graph.getNode(ownerId)?.id
          : resolveDefGraphId(owner.filePath, owner, nodeLookup);
      if (ownerGraphId === undefined || graph.getNode(ownerGraphId) === undefined)
        candidateSetComplete = false;
      else candidateOwnerIds.add(ownerGraphId);
    } else if (
      definition === undefined ||
      definition.type === 'Method' ||
      definition.type === 'Constructor'
    ) {
      candidateSetComplete = false;
    }
  }
  if (candidateGraphIds.size !== ids.length) candidateSetComplete = false;
  const callerId = resolveCallerGraphId(
    site.callerScope ?? site.inScope,
    scopes,
    nodeLookup,
    site.atRange,
  );
  if (callerId === undefined || graph.getNode(callerId) === undefined) candidateSetComplete = false;
  return {
    candidateGraphIds: [...candidateGraphIds],
    candidateOwnerIds: [...candidateOwnerIds],
    callerId,
    candidateSetComplete,
    siteKind: site.kind,
  };
}

export function providerCallOutcome(
  result: ReceiverMemberResolution,
  site: ReferenceSite,
  filePath: string,
  phase: string,
  context: CallOutcomeContext,
): ResolutionOutcome {
  const location = { phase, filePath, name: site.name, range: site.atRange };
  let suppression: Exclude<ReceiverMemberResolution, { kind: 'resolved' }>;
  if (result.kind === 'resolved') {
    const targetId = resolveDefGraphId(
      result.definition.filePath,
      result.definition,
      context.nodeLookup,
    );
    const callerId = resolveCallerGraphId(
      site.callerScope ?? site.inScope,
      context.scopes,
      context.nodeLookup,
      site.atRange,
    );
    if (
      targetId !== undefined &&
      callerId !== undefined &&
      context.graph.getNode(targetId) !== undefined &&
      context.graph.getNode(callerId) !== undefined
    ) {
      return {
        kind: 'resolved',
        targetId: result.definition.nodeId,
        ...location,
      };
    }
    suppression = {
      kind: 'unknown',
      candidateIds: [result.definition.nodeId],
      candidateSetComplete: false,
      detail: 'The selected call could not be represented by graph identities.',
    };
  } else {
    suppression = result;
  }
  return {
    kind: 'suppressed',
    reason:
      suppression.kind === 'ambiguous'
        ? 'member-lookup-ambiguous'
        : suppression.kind === 'unknown'
          ? 'overload-unknown'
          : 'overload-inapplicable',
    candidateIds: suppression.candidateIds,
    detail: suppression.detail,
    ...location,
    ...callSuppressionIdentities(
      suppression.candidateIds,
      site,
      context,
      suppression.candidateSetComplete !== false,
    ),
  };
}
