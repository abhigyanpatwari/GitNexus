import path from 'path';
import { SupportedLanguages, type SymbolDefinition, type Callsite } from 'gitnexus-shared';
import type { GraphNode, RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { generateId } from '../../../../lib/utils.js';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { objectiveCProvider } from '../objective-c.js';
import {
  applyObjectiveCCaptureSideChannel,
  objcClassQualifiedName,
  objcProtocolQualifiedName,
  objcUnresolvedMessageQualifiedName,
  objectiveCFactsFromParsedFiles,
  type ObjCContainerFact,
  type ObjCFileFacts,
  type ObjCMemberFact,
  type ObjCMessageFact,
  type ObjCMethodFact,
  type ObjCTypeInfo,
  parseObjCType,
} from './facts.js';

interface ObjCWorkspaceFacts {
  readonly containersByQualifiedName: ReadonlyMap<string, ObjCContainerFact>;
  readonly classByName: ReadonlyMap<string, ObjCContainerFact>;
  readonly protocolsByName: ReadonlyMap<string, ObjCContainerFact>;
  readonly categoriesByHost: ReadonlyMap<string, readonly ObjCContainerFact[]>;
  readonly methodsByDispatchOwner: ReadonlyMap<string, readonly ObjCMethodFact[]>;
  readonly methodsByExactOwner: ReadonlyMap<string, readonly ObjCMethodFact[]>;
  readonly memberTypesByOwner: ReadonlyMap<string, ReadonlyMap<string, ObjCTypeInfo>>;
  readonly classProtocols: ReadonlyMap<string, ReadonlySet<string>>;
  readonly protocolParents: ReadonlyMap<string, ReadonlySet<string>>;
  readonly superclassByClass: ReadonlyMap<string, string>;
}

export const objectiveCScopeResolver: ScopeResolver = {
  language: SupportedLanguages.ObjectiveC,
  languageProvider: objectiveCProvider,
  importEdgeReason: 'objective-c-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) =>
    resolveObjectiveCImportTarget(targetRaw, fromFile, allFilePaths),

  mergeBindings: (existing, incoming) => [...existing, ...incoming],

  arityCompatibility: (callsite: Callsite, def: SymbolDefinition) => {
    if (callsite.arity === undefined || def.parameterCount === undefined) return 'unknown';
    return callsite.arity === def.parameterCount ? 'compatible' : 'incompatible';
  },

  buildMro: () => new Map(),

  applyCaptureSideChannel: applyObjectiveCCaptureSideChannel,
  populateOwners: () => {},
  isSuperReceiver: (receiverText) => receiverText.trim() === 'super',

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: false,
  collapseMemberCallsByCallerTarget: true,

  emitPostResolutionEdges(graph, parsedFiles) {
    const facts = objectiveCFactsFromParsedFiles(parsedFiles);
    if (facts.length === 0) return;
    const workspace = buildObjectiveCWorkspaceFacts(facts);

    for (const fact of facts) {
      emitObjectiveCHeritageEdges(graph, fact, workspace);
      emitObjectiveCCategoryEdges(graph, fact, workspace);
      emitObjectiveCImplementationEvidence(graph, fact);
      emitObjectiveCUnresolvedMessageEvidence(graph, fact);
      emitObjectiveCMessageEdges(graph, fact, workspace);
    }
  },
};

function graphNodeId(label: string, qualifiedName: string): string {
  return generateId(label, qualifiedName);
}

function relationshipId(
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  reason: string,
): string {
  return generateId(type, `${sourceId}->${targetId}:${reason}`);
}

function addRelationship(
  graph: KnowledgeGraph,
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  reason: string,
  confidence = 0.9,
): void {
  graph.addRelationship({
    id: relationshipId(type, sourceId, targetId, reason),
    sourceId,
    targetId,
    type,
    confidence,
    reason,
  });
}

function labelForContainer(container: ObjCContainerFact): 'Class' | 'Protocol' | 'Category' {
  return container.label;
}

function buildObjectiveCWorkspaceFacts(facts: readonly ObjCFileFacts[]): ObjCWorkspaceFacts {
  const containersByQualifiedName = new Map<string, ObjCContainerFact>();
  const classByName = new Map<string, ObjCContainerFact>();
  const protocolsByName = new Map<string, ObjCContainerFact>();
  const categoriesByHost = new Map<string, ObjCContainerFact[]>();
  const methodsByExactOwner = new Map<string, ObjCMethodFact[]>();
  const methodsByDispatchOwner = new Map<string, ObjCMethodFact[]>();
  const memberTypesByOwner = new Map<string, Map<string, ObjCTypeInfo>>();
  const classProtocols = new Map<string, Set<string>>();
  const protocolParents = new Map<string, Set<string>>();
  const superclassByClass = new Map<string, string>();

  for (const fileFact of facts) {
    for (const container of fileFact.containers) {
      const existing = containersByQualifiedName.get(container.qualifiedName);
      containersByQualifiedName.set(
        container.qualifiedName,
        mergeContainerFacts(existing, container),
      );
      if (container.kind === 'class') {
        classByName.set(container.name, container);
        if (container.superclass !== undefined)
          superclassByClass.set(container.name, container.superclass);
        if (container.protocols.length > 0) {
          let protocols = classProtocols.get(container.name);
          if (protocols === undefined) {
            protocols = new Set();
            classProtocols.set(container.name, protocols);
          }
          for (const protocol of container.protocols) protocols.add(protocol);
        }
      } else if (container.kind === 'protocol') {
        protocolsByName.set(container.name, container);
        if (container.protocols.length > 0) {
          let parents = protocolParents.get(container.name);
          if (parents === undefined) {
            parents = new Set();
            protocolParents.set(container.name, parents);
          }
          for (const protocol of container.protocols) parents.add(protocol);
        }
      } else if (container.hostClass !== undefined) {
        let categories = categoriesByHost.get(container.hostClass);
        if (categories === undefined) {
          categories = [];
          categoriesByHost.set(container.hostClass, categories);
        }
        categories.push(container);
        if (container.protocols.length > 0) {
          let protocols = classProtocols.get(container.hostClass);
          if (protocols === undefined) {
            protocols = new Set();
            classProtocols.set(container.hostClass, protocols);
          }
          for (const protocol of container.protocols) protocols.add(protocol);
        }
      }
    }

    for (const method of fileFact.methods) {
      appendMap(methodsByExactOwner, method.ownerQualifiedName, method);
      appendMap(methodsByDispatchOwner, method.ownerQualifiedName, method);
      if (method.hostClass !== undefined) {
        appendMap(methodsByDispatchOwner, objcClassQualifiedName(method.hostClass), method);
      }
    }

    for (const member of fileFact.members) {
      addMemberType(memberTypesByOwner, member.ownerQualifiedName, member);
      if (member.hostClass !== undefined) {
        addMemberType(memberTypesByOwner, objcClassQualifiedName(member.hostClass), member);
      }
    }
  }

  return {
    containersByQualifiedName,
    classByName,
    protocolsByName,
    categoriesByHost,
    methodsByDispatchOwner,
    methodsByExactOwner,
    memberTypesByOwner,
    classProtocols,
    protocolParents,
    superclassByClass,
  };
}

function addMemberType(
  memberTypesByOwner: Map<string, Map<string, ObjCTypeInfo>>,
  ownerQualifiedName: string,
  member: ObjCMemberFact,
): void {
  const type = parseObjCType(member.declaredType);
  if (type === undefined) return;
  let types = memberTypesByOwner.get(ownerQualifiedName);
  if (types === undefined) {
    types = new Map();
    memberTypesByOwner.set(ownerQualifiedName, types);
  }
  types.set(member.name, type);
}

function mergeContainerFacts(
  existing: ObjCContainerFact | undefined,
  incoming: ObjCContainerFact,
): ObjCContainerFact {
  if (existing === undefined) return incoming;
  const protocols = Array.from(new Set([...existing.protocols, ...incoming.protocols])).sort();
  return {
    ...existing,
    declarationRole:
      existing.declarationRole === 'implementation' || incoming.declarationRole === 'implementation'
        ? 'implementation'
        : 'interface',
    startLine: Math.min(existing.startLine, incoming.startLine),
    endLine: Math.max(existing.endLine, incoming.endLine),
    ...(existing.superclass !== undefined || incoming.superclass !== undefined
      ? { superclass: existing.superclass ?? incoming.superclass }
      : {}),
    protocols,
  };
}

function appendMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

function emitObjectiveCHeritageEdges(
  graph: KnowledgeGraph,
  facts: ObjCFileFacts,
  workspace: ObjCWorkspaceFacts,
): void {
  for (const container of facts.containers) {
    const sourceId = graphNodeId(labelForContainer(container), container.qualifiedName);
    if (container.kind === 'class' && container.superclass !== undefined) {
      const superclass = workspace.classByName.get(container.superclass);
      if (superclass !== undefined) {
        addRelationship(
          graph,
          'EXTENDS',
          sourceId,
          graphNodeId('Class', superclass.qualifiedName),
          'objc: superclass',
        );
      }
    }

    const protocolSourceId =
      container.hostClass !== undefined
        ? graphNodeId('Class', objcClassQualifiedName(container.hostClass))
        : sourceId;
    for (const protocolName of container.protocols) {
      const protocol = workspace.protocolsByName.get(protocolName);
      if (protocol === undefined) continue;
      addRelationship(
        graph,
        'IMPLEMENTS',
        protocolSourceId,
        graphNodeId('Protocol', protocol.qualifiedName),
        'objc: protocol conformance',
      );
    }
  }
}

function emitObjectiveCCategoryEdges(
  graph: KnowledgeGraph,
  facts: ObjCFileFacts,
  workspace: ObjCWorkspaceFacts,
): void {
  for (const container of facts.containers) {
    if (container.hostClass === undefined) continue;
    if (!workspace.classByName.has(container.hostClass)) continue;
    addRelationship(
      graph,
      'MEMBER_OF',
      graphNodeId('Category', container.qualifiedName),
      graphNodeId('Class', objcClassQualifiedName(container.hostClass)),
      'objc: category host class',
    );
  }
}

function emitObjectiveCUnresolvedMessageEvidence(
  graph: KnowledgeGraph,
  facts: ObjCFileFacts,
): void {
  for (const unresolved of facts.unresolvedMessages) {
    const evidenceId = graphNodeId(
      'CodeElement',
      objcUnresolvedMessageQualifiedName(
        facts.filePath,
        unresolved.startLine,
        unresolved.startCol,
        unresolved.selector,
      ),
    );
    addRelationship(
      graph,
      'USES',
      unresolved.sourceMethodId,
      evidenceId,
      `objc-message: unresolved: ${unresolved.reason}`,
      0.5,
    );
  }
}

function emitObjectiveCImplementationEvidence(graph: KnowledgeGraph, facts: ObjCFileFacts): void {
  for (const container of facts.containers) {
    if (container.declarationRole !== 'implementation') continue;
    const targetId = graphNodeId(labelForContainer(container), container.qualifiedName);
    emitImplementationEvidence(
      graph,
      facts.filePath,
      targetId,
      `@implementation ${container.name}`,
      `objc:implementation:${container.qualifiedName}:${facts.filePath}:${container.startLine}`,
      container.startLine,
      container.endLine,
      {
        objectiveCKind: 'implementation-evidence',
        implementationKind: container.kind,
        targetQualifiedName: container.qualifiedName,
      },
    );
  }

  for (const method of facts.methods) {
    if (method.declarationRole !== 'implementation') continue;
    emitImplementationEvidence(
      graph,
      facts.filePath,
      method.nodeId,
      `${method.methodKind}[${method.ownerName} ${method.selector}] implementation`,
      `objc:method-implementation:${method.qualifiedName}:${facts.filePath}:${method.startLine}`,
      method.startLine,
      method.endLine,
      {
        objectiveCKind: 'implementation-evidence',
        implementationKind: 'method',
        targetQualifiedName: method.qualifiedName,
        selector: method.selector,
        methodKind: method.methodKind,
        objectiveCOwner: method.ownerQualifiedName,
      },
    );
  }
}

function emitImplementationEvidence(
  graph: KnowledgeGraph,
  filePath: string,
  targetId: string,
  name: string,
  qualifiedName: string,
  startLine: number,
  endLine: number,
  extras: Record<string, unknown>,
): void {
  const nodeId = graphNodeId('CodeElement', qualifiedName);
  graph.addNode({
    id: nodeId,
    label: 'CodeElement',
    properties: {
      name,
      qualifiedName,
      filePath,
      startLine,
      endLine,
      language: SupportedLanguages.ObjectiveC,
      isExported: false,
      ...extras,
    },
  });
  addRelationship(
    graph,
    'DEFINES',
    graphNodeId('File', filePath),
    nodeId,
    'objc: implementation evidence',
    1,
  );
  addRelationship(graph, 'DECLARES', nodeId, targetId, 'objc: implementation of merged symbol', 1);
}

function emitObjectiveCMessageEdges(
  graph: KnowledgeGraph,
  facts: ObjCFileFacts,
  workspace: ObjCWorkspaceFacts,
): void {
  for (const message of facts.messages) {
    const targets = resolveMessageTargets(message, workspace);
    if (targets.kind === 'none') continue;
    if (targets.kind === 'protocol') {
      emitProtocolMessageEvidence(graph, facts, message, targets.protocolName, targets.candidates);
    }
    for (const target of targets.methods) {
      if (graph.getNode(target.nodeId) === undefined) continue;
      addRelationship(
        graph,
        'CALLS',
        message.sourceMethodId,
        target.nodeId,
        targets.kind === 'protocol'
          ? 'objc-message: protocol receiver'
          : `objc-message: ${message.receiverKind} receiver`,
        targets.kind === 'protocol' ? 0.8 : 0.9,
      );
    }
  }
}

type MessageTargets =
  | { readonly kind: 'none'; readonly methods: readonly ObjCMethodFact[] }
  | { readonly kind: 'direct'; readonly methods: readonly ObjCMethodFact[] }
  | {
      readonly kind: 'protocol';
      readonly protocolName: string;
      readonly methods: readonly ObjCMethodFact[];
      readonly candidates: readonly ObjCMethodFact[];
    };

function resolveMessageTargets(
  message: ObjCMessageFact,
  workspace: ObjCWorkspaceFacts,
): MessageTargets {
  if (message.receiverKind === 'dynamic') {
    return { kind: 'none', methods: [] };
  }

  if (message.receiverKind === 'class') {
    const className = message.receiverType?.name ?? message.receiverText;
    return {
      kind: 'direct',
      methods: findDispatchMethods(workspace, className, '+', message.selector),
    };
  }

  if (message.receiverKind === 'self') {
    const owner = workspace.containersByQualifiedName.get(message.sourceOwnerQualifiedName);
    const className = owner?.hostClass ?? owner?.name ?? message.sourceOwnerName;
    const methods =
      owner?.kind === 'protocol'
        ? findProtocolMethods(workspace, owner.name, message.sourceMethodKind, message.selector)
        : findDispatchMethods(workspace, className, message.sourceMethodKind, message.selector);
    return { kind: 'direct', methods };
  }

  if (message.receiverKind === 'super') {
    const owner = workspace.containersByQualifiedName.get(message.sourceOwnerQualifiedName);
    const className = owner?.hostClass ?? owner?.name ?? message.sourceOwnerName;
    const superclass = workspace.superclassByClass.get(className);
    return superclass === undefined
      ? { kind: 'none', methods: [] }
      : {
          kind: 'direct',
          methods: findDispatchMethods(
            workspace,
            superclass,
            message.sourceMethodKind,
            message.selector,
          ),
        };
  }

  const receiverType = message.receiverType ?? resolveMemberReceiverType(message, workspace);
  if (receiverType?.kind === 'dynamic' || receiverType?.kind === 'class-object') {
    return { kind: 'none', methods: [] };
  }
  if (message.receiverKind === 'unknown' && receiverType === undefined) {
    return { kind: 'none', methods: [] };
  }
  if (receiverType?.kind === 'class' && receiverType.name !== undefined) {
    return {
      kind: 'direct',
      methods: findDispatchMethods(workspace, receiverType.name, '-', message.selector),
    };
  }

  if (receiverType?.kind === 'protocol' && receiverType.name !== undefined) {
    const methods = findProtocolMethods(workspace, receiverType.name, '-', message.selector);
    const candidates = findProtocolImplementationCandidates(
      workspace,
      receiverType.name,
      message.selector,
    );
    return {
      kind: 'protocol',
      protocolName: receiverType.name,
      methods,
      candidates,
    };
  }

  return { kind: 'none', methods: [] };
}

function resolveMemberReceiverType(
  message: ObjCMessageFact,
  workspace: ObjCWorkspaceFacts,
): ObjCTypeInfo | undefined {
  if (message.receiverMemberName === undefined) return undefined;
  const owner = workspace.containersByQualifiedName.get(message.sourceOwnerQualifiedName);
  const ownerQualifiedName =
    owner?.hostClass !== undefined
      ? objcClassQualifiedName(owner.hostClass)
      : message.sourceOwnerQualifiedName;
  return workspace.memberTypesByOwner.get(ownerQualifiedName)?.get(message.receiverMemberName);
}

function findDispatchMethods(
  workspace: ObjCWorkspaceFacts,
  className: string,
  methodKind: '-' | '+',
  selector: string,
): readonly ObjCMethodFact[] {
  const seen = new Set<string>();
  let currentClass: string | undefined = className;
  while (currentClass !== undefined && !seen.has(currentClass)) {
    seen.add(currentClass);
    const ownerQn = objcClassQualifiedName(currentClass);
    const methods = (workspace.methodsByDispatchOwner.get(ownerQn) ?? []).filter(
      (method) => method.methodKind === methodKind && method.selector === selector,
    );
    if (methods.length > 0) return methods;
    currentClass = workspace.superclassByClass.get(currentClass);
  }
  return [];
}

function findExactOwnerMethods(
  workspace: ObjCWorkspaceFacts,
  ownerQualifiedName: string,
  methodKind: '-' | '+',
  selector: string,
): readonly ObjCMethodFact[] {
  return (workspace.methodsByExactOwner.get(ownerQualifiedName) ?? []).filter(
    (method) => method.methodKind === methodKind && method.selector === selector,
  );
}

function findProtocolMethods(
  workspace: ObjCWorkspaceFacts,
  protocolName: string,
  methodKind: '-' | '+',
  selector: string,
): readonly ObjCMethodFact[] {
  for (const name of protocolHierarchy(workspace, protocolName)) {
    const methods = findExactOwnerMethods(
      workspace,
      objcProtocolQualifiedName(name),
      methodKind,
      selector,
    );
    if (methods.length > 0) return uniqueMethods(methods);
  }
  return [];
}

function protocolHierarchy(workspace: ObjCWorkspaceFacts, protocolName: string): readonly string[] {
  const seen = new Set<string>();
  const pending = [protocolName];
  const hierarchy: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    hierarchy.push(current);
    const parents = workspace.protocolParents.get(current);
    if (parents === undefined) continue;
    pending.push(...[...parents].sort());
  }
  return hierarchy;
}

function uniqueMethods(methods: readonly ObjCMethodFact[]): readonly ObjCMethodFact[] {
  return [...new Map(methods.map((method) => [method.nodeId, method])).values()].sort(
    (left, right) => left.qualifiedName.localeCompare(right.qualifiedName),
  );
}

function classConformsToProtocol(
  workspace: ObjCWorkspaceFacts,
  directProtocols: ReadonlySet<string>,
  protocolName: string,
): boolean {
  return [...directProtocols].some((directProtocol) =>
    protocolHierarchy(workspace, directProtocol).includes(protocolName),
  );
}

function findProtocolImplementationCandidates(
  workspace: ObjCWorkspaceFacts,
  protocolName: string,
  selector: string,
): readonly ObjCMethodFact[] {
  const out: ObjCMethodFact[] = [];
  for (const [className, protocols] of workspace.classProtocols) {
    if (!classConformsToProtocol(workspace, protocols, protocolName)) continue;
    out.push(...findDispatchMethods(workspace, className, '-', selector));
  }
  return uniqueMethods(out);
}

function emitProtocolMessageEvidence(
  graph: KnowledgeGraph,
  facts: ObjCFileFacts,
  message: ObjCMessageFact,
  protocolName: string,
  candidates: readonly ObjCMethodFact[],
): void {
  if (candidates.length === 0) return;
  const qualifiedName = `objc:protocol-candidates:${facts.filePath}:${message.startLine}:${message.startCol}:${message.selector}`;
  const nodeId = graphNodeId('CodeElement', qualifiedName);
  const node: GraphNode = {
    id: nodeId,
    label: 'CodeElement',
    properties: {
      name: `[${message.receiverText} ${message.selector}] protocol ${protocolName} candidates`,
      qualifiedName,
      filePath: facts.filePath,
      startLine: message.startLine,
      endLine: message.startLine,
      language: SupportedLanguages.ObjectiveC,
      isExported: false,
    },
  };
  graph.addNode(node);
  addRelationship(
    graph,
    'DEFINES',
    graphNodeId('File', facts.filePath),
    nodeId,
    `objc: protocol receiver candidate evidence: ${protocolName} ${message.selector}`,
    1,
  );
  addRelationship(
    graph,
    'USES',
    message.sourceMethodId,
    nodeId,
    `objc-message: protocol receiver candidates: ${protocolName} ${message.selector}`,
    0.7,
  );
  for (const candidate of candidates) {
    if (graph.getNode(candidate.nodeId) === undefined) continue;
    addRelationship(
      graph,
      'USES',
      nodeId,
      candidate.nodeId,
      `objc-protocol-candidate: ${protocolName} ${message.selector}`,
      0.5,
    );
  }
}

function resolveObjectiveCImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const importIndex = getObjectiveCImportIndex(allFilePaths);
  const target = targetRaw.trim();
  if (target.length === 0) return null;
  if (target.startsWith('<') && target.endsWith('>')) return null;
  const looksLikeFileImport =
    target.startsWith('.') || target.includes('/') || path.posix.extname(target).length > 0;
  if (!looksLikeFileImport) return null;
  return findImportCandidate(target, fromFile, importIndex);
}

interface ObjectiveCImportIndex {
  readonly filePaths: readonly string[];
  readonly filePathSet: ReadonlySet<string>;
}

const getObjectiveCImportIndex = perFileSet(
  (allFilePaths: ReadonlySet<string>): ObjectiveCImportIndex => {
    const filePaths = [...allFilePaths];
    return { filePaths, filePathSet: new Set(filePaths) };
  },
);

function findImportCandidate(
  targetRaw: string,
  fromFile: string,
  importIndex: ObjectiveCImportIndex,
): string | null {
  const normalizedTarget = normalizeRepoPath(targetRaw);
  const fromDir = normalizeRepoPath(path.posix.dirname(normalizeRepoPath(fromFile)));
  const spelledCandidates = new Set<string>([
    normalizeRepoPath(path.posix.join(fromDir, normalizedTarget)),
    normalizedTarget,
  ]);
  const ext = path.posix.extname(normalizedTarget);
  if (ext.length === 0) {
    for (const base of [...spelledCandidates]) {
      spelledCandidates.add(`${base}.h`);
      spelledCandidates.add(`${base}.m`);
      spelledCandidates.add(`${base}.mm`);
    }
  }
  for (const candidate of spelledCandidates) {
    if (importIndex.filePathSet.has(candidate)) return candidate;
  }
  const suffixes = [...spelledCandidates].map((candidate) => `/${candidate}`);
  for (const filePath of importIndex.filePaths) {
    const normalizedFilePath = normalizeRepoPath(filePath);
    if (suffixes.some((suffix) => normalizedFilePath.endsWith(suffix))) return filePath;
  }
  return null;
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}
