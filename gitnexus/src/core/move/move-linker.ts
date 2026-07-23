import type { GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import type { CallGraphMap } from './compiler-facts.js';
import { MOVE_EDGE_REASON, MOVE_LANGUAGE } from './constants.js';
import type { DroppedRef, PendingRef, PendingRefKind } from './refs.js';
import {
  moveExternalTypeNodeId,
  moveFunctionNodeId,
  moveLocalName,
  moveModuleNodeId,
  moveModuleQualifiedName,
  moveRelId,
  parseMoveModuleQualifiedName,
} from './symbol-id.js';

export interface MoveLinkView {
  moduleFileMap: ReadonlyMap<string, string>;
  functionNodeMap: ReadonlyMap<string, string>;
  structNodeMap: ReadonlyMap<string, string>;
  callGraphByPackage: ReadonlyMap<string, CallGraphMap>;
  closureCallsByPackage: ReadonlyMap<string, CallGraphMap>;
  pendingRefs: readonly PendingRef[];
  droppedRefs: DroppedRef[];
}

export class ExternalMoveSymbols {
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

/** Strip generic type arguments: `CoinStore<CoinType>` → `CoinStore`. */
function stripTypeArgs(typeName: string): string {
  const idx = typeName.indexOf('<');
  return (idx === -1 ? typeName : typeName.slice(0, idx)).trim();
}

export function buildLocalNameIndex(
  structNodeMap: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const structIdsByLocalName = new Map<string, string[]>();
  for (const [qn, id] of structNodeMap) {
    const key = moveLocalName(qn);
    const list = structIdsByLocalName.get(key);
    if (list) list.push(id);
    else structIdsByLocalName.set(key, [id]);
  }
  return structIdsByLocalName;
}

export function resolveStructRef(
  localOrQualified: string,
  callerModule: string,
  structNodeMap: ReadonlyMap<string, string>,
  structIdsByLocalName: ReadonlyMap<string, readonly string[]>,
): { targetId: string } | { unresolved: true } | { ambiguous: true } {
  const exact = structNodeMap.get(localOrQualified);
  if (exact) return { targetId: exact };

  const base = stripTypeArgs(localOrQualified);
  const baseExact = structNodeMap.get(base);
  if (baseExact) return { targetId: baseExact };

  // move-flow emits every resourceAccess/param/return ref fully qualified, so a
  // qualified ref that misses the exact lookup is a type outside the indexed
  // graph (e.g. a dependency-only 0x1::coin::CoinStore). Falling through to the
  // bare-name heuristic would silently mis-bind it to a same-named repo struct
  // under a different address - report unresolved instead. The heuristics below
  // remain only for unqualified inputs.
  if (base.includes('::')) return { unresolved: true };

  const sameModule = structNodeMap.get(`${callerModule}::${base}`);
  if (sameModule) return { targetId: sameModule };

  const matches = structIdsByLocalName.get(moveLocalName(base)) ?? [];
  if (matches.length === 1) return { targetId: matches[0] };
  return matches.length > 1 ? { ambiguous: true } : { unresolved: true };
}

export interface RefIndexes {
  structNodeMap: ReadonlyMap<string, string>;
  structIdsByLocalName: ReadonlyMap<string, readonly string[]>;
  moduleFileMap: ReadonlyMap<string, string>;
  functionNodeMap: ReadonlyMap<string, string>;
}

type Resolution = { id: string } | 'unresolved' | 'ambiguous';

interface RefDescriptor {
  resolve(target: string, moduleQualified: string, idx: RefIndexes): Resolution;
  externalize?(target: string, external: ExternalMoveSymbols): string | undefined;
  direction: 'known-source' | 'known-target';
  confidence?: number;
  postEdge?(graph: KnowledgeGraph, rel: GraphRelationship): void;
}

const REF_DESCRIPTORS: Record<PendingRefKind, RefDescriptor> = {
  resource: {
    resolve: (t, m, idx) => {
      const r = resolveStructRef(t, m, idx.structNodeMap, idx.structIdsByLocalName);
      if ('targetId' in r) return { id: r.targetId };
      if ('ambiguous' in r) return 'ambiguous';
      return 'unresolved';
    },
    externalize: (t, ext) => ext.ensureType(t),
    direction: 'known-source',
  },
  type: {
    resolve: (t, m, idx) => {
      const r = resolveStructRef(t, m, idx.structNodeMap, idx.structIdsByLocalName);
      if ('targetId' in r) return { id: r.targetId };
      if ('ambiguous' in r) return 'ambiguous';
      return 'unresolved';
    },
    externalize: (t, ext) => ext.ensureType(t),
    direction: 'known-source',
    postEdge: recordUsedType,
  },
  friend: {
    resolve: (t, _m, idx) => {
      const file = idx.moduleFileMap.get(t);
      return file ? { id: moveModuleNodeId(t, file) } : 'unresolved';
    },
    externalize: (t, ext) => ext.ensureModule(t),
    direction: 'known-source',
  },
  'lambda-host': {
    resolve: (t, _m, idx) => {
      const id = idx.functionNodeMap.get(t);
      return id ? { id } : 'unresolved';
    },
    direction: 'known-target',
    confidence: 0.9,
  },
};

/** `usedTypes` bookkeeping for USES_TYPE edges (was addTypeRelationship). */
function recordUsedType(graph: KnowledgeGraph, rel: GraphRelationship): void {
  const source = graph.getNode(rel.sourceId);
  const target = graph.getNode(rel.targetId);
  const qualifiedName = target?.properties.qualifiedName;
  if (!source || source.label !== 'Function' || typeof qualifiedName !== 'string') return;
  const usedTypes = Array.isArray(source.properties.usedTypes) ? source.properties.usedTypes : [];
  if (!usedTypes.includes(qualifiedName))
    source.properties.usedTypes = [...usedTypes, qualifiedName];
}

export function resolveRefs(
  graph: KnowledgeGraph,
  refs: readonly PendingRef[],
  indexes: RefIndexes,
  external: ExternalMoveSymbols,
  drops: DroppedRef[],
): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    const desc = REF_DESCRIPTORS[ref.kind];
    const resolved = desc.resolve(ref.target, ref.moduleQualified, indexes);
    let targetId: string | undefined;
    if (resolved === 'ambiguous') {
      drops.push({ kind: ref.kind, sourceId: ref.knownNodeId, target: ref.target });
      continue;
    }
    if (resolved === 'unresolved') {
      targetId = desc.externalize?.(ref.target, external);
      if (!targetId) {
        drops.push({ kind: ref.kind, sourceId: ref.knownNodeId, target: ref.target });
        continue;
      }
    } else {
      targetId = resolved.id;
    }
    const sourceId = desc.direction === 'known-target' ? targetId : ref.knownNodeId;
    const dstId = desc.direction === 'known-target' ? ref.knownNodeId : targetId;
    const key = `${sourceId}\0${ref.edgeType}\0${dstId}\0${ref.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rel: GraphRelationship = {
      id: moveRelId(sourceId, ref.edgeType, dstId, ref.reason),
      sourceId,
      targetId: dstId,
      type: ref.edgeType,
      confidence: desc.confidence ?? 1.0,
      reason: ref.reason,
    };
    graph.addRelationship(rel);
    desc.postEdge?.(graph, rel);
  }
}

export function linkMoveIngestGraph(graph: KnowledgeGraph, state: MoveLinkView): void {
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
  const structIdsByLocalName = buildLocalNameIndex(state.structNodeMap);
  const indexes: RefIndexes = {
    structNodeMap: state.structNodeMap,
    structIdsByLocalName,
    moduleFileMap: state.moduleFileMap,
    functionNodeMap: state.functionNodeMap,
  };
  resolveRefs(graph, state.pendingRefs, indexes, external, state.droppedRefs);
  linkFileImports(graph, state);
  linkFileModuleContains(graph, state);
}

function linkCallGraph(
  graph: KnowledgeGraph,
  state: MoveLinkView,
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

function linkFileImports(graph: KnowledgeGraph, state: MoveLinkView): void {
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

function linkFileModuleContains(graph: KnowledgeGraph, state: MoveLinkView): void {
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
