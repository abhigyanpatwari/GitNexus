import type { GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import type { CallGraphMap } from './compiler-facts.js';
import { MOVE_EDGE_REASON, MOVE_LANGUAGE } from './constants.js';
import {
  buildLocalNameIndex,
  resolveFriendEdges,
  resolveLambdaHostEdges,
  resolveResourceEdges,
  resolveTypeRefEdges,
  type PendingFriend,
  type PendingLambdaHost,
  type PendingResource,
  type PendingTypeRef,
} from './facts-mapper.js';
import {
  moveExternalTypeNodeId,
  moveFunctionNodeId,
  moveLocalName,
  moveModuleNodeId,
  moveModuleQualifiedName,
  moveRelId,
  parseMoveModuleQualifiedName,
} from './symbol-id.js';

export interface MoveLinkState {
  moduleFileMap: Map<string, string>;
  functionNodeMap: Map<string, string>;
  structNodeMap: Map<string, string>;
  callGraphByPackage: Map<string, CallGraphMap>;
  closureCallsByPackage: Map<string, CallGraphMap>;
  pendingResource: PendingResource[];
  pendingFriends: PendingFriend[];
  pendingTypeRef: PendingTypeRef[];
  pendingLambdaHosts: PendingLambdaHost[];
  droppedResourceRefs: { fnNodeId: string; target: string }[];
  droppedTypeRefs: { sourceNodeId: string; target: string }[];
  droppedFriends: { moduleNodeId: string; friend: string }[];
  droppedLambdaHosts: { lambdaFnNodeId: string; hostQualified: string }[];
}

class ExternalMoveSymbols {
  private readonly modules = new Map<string, string>();
  private readonly functions = new Map<string, string>();
  private readonly types = new Map<string, string>();

  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly localModules: ReadonlyMap<string, string>,
  ) {}

  ensureModule(moduleQualified: string): string | undefined {
    if (this.localModules.has(moduleQualified)) return undefined;
    const existing = this.modules.get(moduleQualified);
    if (existing) return existing;

    const { address, moduleName } = parseMoveModuleQualifiedName(moduleQualified);
    if (!address || !moduleName) return undefined;
    const moduleId = moveModuleNodeId(moduleQualified, '');
    this.graph.addNode({
      id: moduleId,
      label: 'Module',
      properties: {
        name: moduleName,
        filePath: '',
        language: MOVE_LANGUAGE,
        qualifiedName: moduleQualified,
        moduleQualifiedName: moduleQualified,
        moduleAddress: address,
        description: `External Move dependency module ${moduleQualified}`,
        locationFidelity: 'external',
      },
    });
    this.modules.set(moduleQualified, moduleId);
    return moduleId;
  }

  ensureFunction(functionQualified: string): string | undefined {
    const existing = this.functions.get(functionQualified);
    if (existing) return existing;
    const moduleQualified = moveModuleQualifiedName(functionQualified);
    const moduleId = this.ensureModule(moduleQualified);
    if (!moduleId) return undefined;

    const functionId = moveFunctionNodeId(functionQualified, '');
    this.graph.addNode({
      id: functionId,
      label: 'Function',
      properties: {
        name: moveLocalName(functionQualified),
        filePath: '',
        language: MOVE_LANGUAGE,
        qualifiedName: functionQualified,
        moduleQualifiedName: moduleQualified,
        visibility: 'external',
        visibilityModifier: 'external',
        isExported: true,
        description: `External Move dependency function ${functionQualified}`,
        locationFidelity: 'external',
      },
    });
    this.addDefinition(moduleId, functionId, MOVE_EDGE_REASON.externalDefinesFunction);
    this.functions.set(functionQualified, functionId);
    return functionId;
  }

  ensureType(typeQualified: string): string | undefined {
    const existing = this.types.get(typeQualified);
    if (existing) return existing;
    const moduleQualified = moveModuleQualifiedName(typeQualified);
    const moduleId = this.ensureModule(moduleQualified);
    if (!moduleId) return undefined;

    const typeId = moveExternalTypeNodeId(typeQualified);
    this.graph.addNode({
      id: typeId,
      label: 'Type',
      properties: {
        name: moveLocalName(typeQualified),
        filePath: '',
        language: MOVE_LANGUAGE,
        qualifiedName: typeQualified,
        moduleQualifiedName: moduleQualified,
        description: `External Move dependency type ${typeQualified}`,
        locationFidelity: 'external',
      },
    });
    this.addDefinition(moduleId, typeId, MOVE_EDGE_REASON.externalDefinesType);
    this.types.set(typeQualified, typeId);
    return typeId;
  }

  private addDefinition(moduleId: string, targetId: string, reason: string): void {
    this.graph.addRelationship({
      id: moveRelId(moduleId, 'DEFINES', targetId, reason),
      sourceId: moduleId,
      targetId,
      type: 'DEFINES',
      confidence: 1.0,
      reason,
    });
  }
}

export function linkMoveIngestGraph(graph: KnowledgeGraph, state: MoveLinkState): void {
  const external = new ExternalMoveSymbols(graph, state.moduleFileMap);
  linkCallGraph(
    graph,
    state,
    external,
    state.callGraphByPackage.values(),
    MOVE_EDGE_REASON.calls,
    1.0,
  );
  linkCallGraph(
    graph,
    state,
    external,
    state.closureCallsByPackage.values(),
    MOVE_EDGE_REASON.closureUse,
    0.95,
  );
  linkLambdaHostEdges(graph, state);
  linkResourceFriendAndTypeEdges(graph, state, external);
  linkFileImports(graph, state);
  linkFileModuleContains(graph, state);
}

function linkCallGraph(
  graph: KnowledgeGraph,
  state: MoveLinkState,
  external: ExternalMoveSymbols,
  callGraphs: Iterable<CallGraphMap>,
  reason: string,
  confidence: number,
): void {
  for (const callGraph of callGraphs) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerId = state.functionNodeMap.get(callerQualified);
      if (!callerId) continue;
      for (const calleeQualified of callees) {
        const calleeId =
          state.functionNodeMap.get(calleeQualified) ?? external.ensureFunction(calleeQualified);
        if (!calleeId) continue;
        graph.addRelationship({
          id: moveRelId(callerId, 'CALLS', calleeId, reason),
          sourceId: callerId,
          targetId: calleeId,
          type: 'CALLS',
          confidence,
          reason,
        });
      }
    }
  }
}

function linkLambdaHostEdges(graph: KnowledgeGraph, state: MoveLinkState): void {
  resolveLambdaHostEdges(
    state.pendingLambdaHosts,
    state.functionNodeMap,
    (relationship) => graph.addRelationship(relationship),
    (pending) =>
      state.droppedLambdaHosts.push({
        lambdaFnNodeId: pending.lambdaFnNodeId,
        hostQualified: pending.hostQualified,
      }),
  );
}

function linkResourceFriendAndTypeEdges(
  graph: KnowledgeGraph,
  state: MoveLinkState,
  external: ExternalMoveSymbols,
): void {
  const structIdsByLocalName = buildLocalNameIndex(state.structNodeMap);
  resolveResourceEdges(
    state.pendingResource,
    state.structNodeMap,
    structIdsByLocalName,
    (relationship) => graph.addRelationship(relationship),
    (pending) => linkExternalResource(graph, state, external, pending),
    (pending) =>
      state.droppedResourceRefs.push({
        fnNodeId: pending.fnNodeId,
        target: pending.target,
      }),
  );
  resolveFriendEdges(
    state.pendingFriends,
    state.moduleFileMap,
    (relationship) => graph.addRelationship(relationship),
    (pending) => linkExternalFriend(graph, state, external, pending),
  );

  const dropTypeRef = (pending: PendingTypeRef): void => {
    state.droppedTypeRefs.push({
      sourceNodeId: pending.sourceNodeId,
      target: pending.target,
    });
  };
  resolveTypeRefEdges(
    state.pendingTypeRef,
    state.structNodeMap,
    structIdsByLocalName,
    (relationship) => addTypeRelationship(graph, relationship),
    (pending) => {
      const targetId = external.ensureType(pending.target);
      if (!targetId) {
        dropTypeRef(pending);
        return;
      }
      addTypeRelationship(graph, {
        id: moveRelId(pending.sourceNodeId, 'USES_TYPE', targetId, pending.reason),
        sourceId: pending.sourceNodeId,
        targetId,
        type: 'USES_TYPE',
        confidence: 1.0,
        reason: pending.reason,
      });
    },
    dropTypeRef,
  );
}

function linkExternalResource(
  graph: KnowledgeGraph,
  state: MoveLinkState,
  external: ExternalMoveSymbols,
  pending: PendingResource,
): void {
  const targetId = external.ensureType(pending.target);
  if (!targetId) {
    state.droppedResourceRefs.push({
      fnNodeId: pending.fnNodeId,
      target: pending.target,
    });
    return;
  }
  graph.addRelationship({
    id: moveRelId(pending.fnNodeId, pending.type, targetId, pending.reason),
    sourceId: pending.fnNodeId,
    targetId,
    type: pending.type,
    confidence: 1.0,
    reason: pending.reason,
  });
}

function linkExternalFriend(
  graph: KnowledgeGraph,
  state: MoveLinkState,
  external: ExternalMoveSymbols,
  pending: PendingFriend,
): void {
  const targetId = external.ensureModule(pending.friend);
  if (!targetId) {
    state.droppedFriends.push({
      moduleNodeId: pending.moduleNodeId,
      friend: pending.friend,
    });
    return;
  }
  graph.addRelationship({
    id: moveRelId(pending.moduleNodeId, 'FRIEND_OF', targetId, MOVE_EDGE_REASON.friend),
    sourceId: pending.moduleNodeId,
    targetId,
    type: 'FRIEND_OF',
    confidence: 1.0,
    reason: MOVE_EDGE_REASON.friend,
  });
}

function addTypeRelationship(graph: KnowledgeGraph, relationship: GraphRelationship): void {
  graph.addRelationship(relationship);
  const source = graph.getNode(relationship.sourceId);
  const target = graph.getNode(relationship.targetId);
  const qualifiedName = target?.properties.qualifiedName;
  if (!source || source.label !== 'Function' || typeof qualifiedName !== 'string') return;

  const usedTypes = Array.isArray(source.properties.usedTypes) ? source.properties.usedTypes : [];
  if (!usedTypes.includes(qualifiedName)) {
    source.properties.usedTypes = [...usedTypes, qualifiedName];
  }
}

function linkFileImports(graph: KnowledgeGraph, state: MoveLinkState): void {
  const seen = new Set<string>();
  for (const relationship of graph.iterRelationshipsByType('IMPORTS')) {
    if (!relationship.sourceId.startsWith('File:') || !relationship.targetId.startsWith('File:')) {
      continue;
    }
    seen.add(`${relationship.sourceId.slice(5)}\0${relationship.targetId.slice(5)}`);
  }

  for (const callGraph of [
    ...state.callGraphByPackage.values(),
    ...state.closureCallsByPackage.values(),
  ]) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerFile = state.moduleFileMap.get(moveModuleQualifiedName(callerQualified));
      if (!callerFile) continue;
      for (const calleeQualified of callees) {
        const calleeFile = state.moduleFileMap.get(moveModuleQualifiedName(calleeQualified));
        if (!calleeFile || calleeFile === callerFile) continue;
        const key = `${callerFile}\0${calleeFile}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceFileId = `File:${callerFile}`;
        const targetFileId = `File:${calleeFile}`;
        if (!graph.getNode(sourceFileId) || !graph.getNode(targetFileId)) continue;
        graph.addRelationship({
          id: moveRelId(
            sourceFileId,
            'IMPORTS',
            targetFileId,
            MOVE_EDGE_REASON.crossModuleDependency,
          ),
          sourceId: sourceFileId,
          targetId: targetFileId,
          type: 'IMPORTS',
          confidence: 0.9,
          reason: MOVE_EDGE_REASON.crossModuleDependency,
        });
      }
    }
  }
}

function linkFileModuleContains(graph: KnowledgeGraph, state: MoveLinkState): void {
  for (const [moduleQualified, file] of state.moduleFileMap) {
    const fileNodeId = `File:${file}`;
    const moduleNodeId = moveModuleNodeId(moduleQualified, file);
    if (!graph.getNode(fileNodeId) || !graph.getNode(moduleNodeId)) continue;
    graph.addRelationship({
      id: moveRelId(fileNodeId, 'CONTAINS', moduleNodeId, MOVE_EDGE_REASON.moduleInFile),
      sourceId: fileNodeId,
      targetId: moduleNodeId,
      type: 'CONTAINS',
      confidence: 1.0,
      reason: MOVE_EDGE_REASON.moduleInFile,
    });
  }
}
