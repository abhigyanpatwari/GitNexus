import {
  SupportedLanguages,
  type ParsedFile,
  type SymbolDefinition,
  type Callsite,
} from 'gitnexus-shared';
import type { RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { generateId } from '../../../../lib/utils.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import { objectiveCProvider } from '../objective-c.js';
import { populateObjectiveCCompilationUnitSiblings } from './compilation-unit-siblings.js';
import { resolveObjectiveCImportTarget } from './import-target.js';
import { loadObjectiveCResolutionConfig } from './resolution-config.js';
import {
  applyObjectiveCCaptureSideChannel,
  isInternalObjectiveCFunctionDef,
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
  readonly methodsByDispatchOwner: ReadonlyMap<string, readonly ObjCMethodFact[]>;
  readonly methodsByExactOwner: ReadonlyMap<string, readonly ObjCMethodFact[]>;
  readonly memberTypesByOwner: ReadonlyMap<string, ReadonlyMap<string, ObjCTypeInfo>>;
  readonly classProtocols: ReadonlyMap<string, ReadonlySet<string>>;
  readonly protocolParents: ReadonlyMap<string, ReadonlySet<string>>;
  readonly superclassByClass: ReadonlyMap<string, string>;
  /** Class names that conform to each protocol, including inherited protocols. */
  readonly classesByProtocol: ReadonlyMap<string, readonly string[]>;
  /**
   * Per-(protocol, selector) implementer methods. Filled on first query so
   * N messages to the same protocol do not rescan the class set.
   */
  readonly protocolImplementationBySelector: Map<string, readonly ObjCMethodFact[]>;
  /**
   * Shared implementer-evidence nodes already written. The implementer
   * USES fan-out is emitted once; later messages only add the
   * source→shared hop (C# workspaceTypeBindings analog).
   */
  readonly emittedProtocolCandidateSets: Set<string>;
}

export const objectiveCScopeResolver: ScopeResolver = {
  language: SupportedLanguages.ObjectiveC,
  languageProvider: objectiveCProvider,
  importEdgeReason: 'objective-c-scope: import',

  loadResolutionConfig: (repoPath) => loadObjectiveCResolutionConfig(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveObjectiveCImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  mergeBindings: (existing, incoming) => [...existing, ...incoming],

  arityCompatibility: (callsite: Callsite, def: SymbolDefinition) => {
    if (callsite.arity === undefined || def.parameterCount === undefined) return 'unknown';
    return callsite.arity === def.parameterCount ? 'compatible' : 'incompatible';
  },

  buildMro: () => new Map(),

  applyCaptureSideChannel: applyObjectiveCCaptureSideChannel,
  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),
  populateNamespaceSiblings: populateObjectiveCCompilationUnitSiblings,
  isFileLocalDef: (def: SymbolDefinition) => isInternalObjectiveCFunctionDef(def),
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

  const hierarchyWorkspace = { protocolParents };
  const classNames = new Set([...classByName.keys(), ...classProtocols.keys()]);
  const classesByProtocol = new Map<string, string[]>();
  for (const className of classNames) {
    const seenClasses = new Set<string>();
    let currentClass: string | undefined = className;
    while (currentClass !== undefined && !seenClasses.has(currentClass)) {
      seenClasses.add(currentClass);
      const directProtocols = classProtocols.get(currentClass);
      if (directProtocols !== undefined) {
        for (const directProtocol of directProtocols) {
          for (const protocolName of protocolHierarchy(hierarchyWorkspace, directProtocol)) {
            let implementers = classesByProtocol.get(protocolName);
            if (implementers === undefined) {
              implementers = [];
              classesByProtocol.set(protocolName, implementers);
            }
            implementers.push(className);
          }
        }
      }
      currentClass = superclassByClass.get(currentClass);
    }
  }
  const classesByProtocolFrozen = new Map<string, readonly string[]>();
  for (const [protocolName, implementers] of classesByProtocol) {
    classesByProtocolFrozen.set(
      protocolName,
      Object.freeze([...new Set(implementers)].sort((left, right) => left.localeCompare(right))),
    );
  }

  return {
    containersByQualifiedName,
    classByName,
    protocolsByName,
    methodsByDispatchOwner,
    methodsByExactOwner,
    memberTypesByOwner,
    classProtocols,
    protocolParents,
    superclassByClass,
    classesByProtocol: classesByProtocolFrozen,
    protocolImplementationBySelector: new Map(),
    emittedProtocolCandidateSets: new Set(),
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
    if (targets.kind === 'category-collision') {
      emitCategoryDispatchEvidence(graph, facts, message, targets.candidates);
      continue;
    }
    if (targets.kind === 'protocol') {
      emitProtocolMessageEvidence(
        graph,
        facts,
        message,
        targets.protocolName,
        targets.candidates,
        workspace,
      );
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
  | { readonly kind: 'category-collision'; readonly candidates: readonly ObjCMethodFact[] }
  | {
      readonly kind: 'protocol';
      readonly protocolName: string;
      readonly methods: readonly ObjCMethodFact[];
      readonly candidates: readonly ObjCMethodFact[];
    };

function messageTargetsFromDispatchLookup(lookup: DispatchMethodLookup): MessageTargets {
  return lookup.categoryCollision
    ? { kind: 'category-collision', candidates: lookup.methods }
    : { kind: 'direct', methods: lookup.methods };
}

function resolveMessageTargets(
  message: ObjCMessageFact,
  workspace: ObjCWorkspaceFacts,
): MessageTargets {
  if (message.receiverKind === 'dynamic') {
    return { kind: 'none', methods: [] };
  }

  if (message.receiverKind === 'class') {
    const className = message.receiverType?.name ?? message.receiverText;
    return messageTargetsFromDispatchLookup(
      findDispatchMethods(workspace, className, '+', message.selector),
    );
  }

  if (message.receiverKind === 'self') {
    const owner = workspace.containersByQualifiedName.get(message.sourceOwnerQualifiedName);
    const className = owner?.hostClass ?? owner?.name ?? message.sourceOwnerName;
    if (owner?.kind === 'protocol') {
      return {
        kind: 'direct',
        methods: findProtocolMethods(
          workspace,
          owner.name,
          message.sourceMethodKind,
          message.selector,
        ),
      };
    }
    return messageTargetsFromDispatchLookup(
      findDispatchMethods(workspace, className, message.sourceMethodKind, message.selector),
    );
  }

  if (message.receiverKind === 'super') {
    const owner = workspace.containersByQualifiedName.get(message.sourceOwnerQualifiedName);
    const className = owner?.hostClass ?? owner?.name ?? message.sourceOwnerName;
    const superclass = workspace.superclassByClass.get(className);
    return superclass === undefined
      ? { kind: 'none', methods: [] }
      : messageTargetsFromDispatchLookup(
          findDispatchMethods(workspace, superclass, message.sourceMethodKind, message.selector),
        );
  }

  const receiverType = message.receiverType ?? resolveMemberReceiverType(message, workspace);
  if (receiverType?.kind === 'dynamic' || receiverType?.kind === 'class-object') {
    return { kind: 'none', methods: [] };
  }
  if (message.receiverKind === 'unknown' && receiverType === undefined) {
    return { kind: 'none', methods: [] };
  }
  if (receiverType?.kind === 'class' && receiverType.name !== undefined) {
    return messageTargetsFromDispatchLookup(
      findDispatchMethods(workspace, receiverType.name, '-', message.selector),
    );
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
  let className = owner?.hostClass ?? owner?.name ?? message.sourceOwnerName;
  const seen = new Set<string>();
  while (className !== undefined && !seen.has(className)) {
    seen.add(className);
    const type = workspace.memberTypesByOwner
      .get(objcClassQualifiedName(className))
      ?.get(message.receiverMemberName);
    if (type !== undefined) return type;
    className = workspace.superclassByClass.get(className);
  }
  return workspace.memberTypesByOwner
    .get(message.sourceOwnerQualifiedName)
    ?.get(message.receiverMemberName);
}

function findDispatchMethods(
  workspace: ObjCWorkspaceFacts,
  className: string,
  methodKind: '-' | '+',
  selector: string,
): DispatchMethodLookup {
  const seen = new Set<string>();
  let currentClass: string | undefined = className;
  while (currentClass !== undefined && !seen.has(currentClass)) {
    seen.add(currentClass);
    const ownerQn = objcClassQualifiedName(currentClass);
    const methods = uniqueMethods(
      (workspace.methodsByDispatchOwner.get(ownerQn) ?? []).filter(
        (method) => method.methodKind === methodKind && method.selector === selector,
      ),
    );
    if (methods.length > 0) {
      return {
        methods,
        // Named categories can replace a host-class implementation at runtime,
        // but image-load order is not statically knowable. Preserve all targets
        // as evidence instead of claiming that each is a certain CALLS edge.
        categoryCollision:
          methods.length > 1 && methods.some((method) => method.ownerKind === 'category'),
      };
    }
    currentClass = workspace.superclassByClass.get(currentClass);
  }
  return { methods: [], categoryCollision: false };
}

interface DispatchMethodLookup {
  readonly methods: readonly ObjCMethodFact[];
  readonly categoryCollision: boolean;
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

function protocolHierarchy(
  workspace: Pick<ObjCWorkspaceFacts, 'protocolParents'>,
  protocolName: string,
): readonly string[] {
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

function findProtocolImplementationCandidates(
  workspace: ObjCWorkspaceFacts,
  protocolName: string,
  selector: string,
): readonly ObjCMethodFact[] {
  const cacheKey = `${protocolName}\0${selector}`;
  const cached = workspace.protocolImplementationBySelector.get(cacheKey);
  if (cached !== undefined) return cached;

  const out: ObjCMethodFact[] = [];
  for (const className of workspace.classesByProtocol.get(protocolName) ?? []) {
    out.push(...findDispatchMethods(workspace, className, '-', selector).methods);
  }
  const result = uniqueMethods(out);
  workspace.protocolImplementationBySelector.set(cacheKey, result);
  return result;
}

function emitCategoryDispatchEvidence(
  graph: KnowledgeGraph,
  facts: ObjCFileFacts,
  message: ObjCMessageFact,
  candidates: readonly ObjCMethodFact[],
): void {
  if (candidates.length === 0) return;
  const qualifiedName =
    `objc:category-dispatch-candidates:${facts.filePath}:` +
    `${message.startLine}:${message.startCol}:${message.selector}`;
  const nodeId = graphNodeId('CodeElement', qualifiedName);
  graph.addNode({
    id: nodeId,
    label: 'CodeElement',
    properties: {
      name: `[${message.receiverText} ${message.selector}] category dispatch candidates`,
      qualifiedName,
      filePath: facts.filePath,
      startLine: message.startLine,
      endLine: message.startLine,
      language: SupportedLanguages.ObjectiveC,
      isExported: false,
      objectiveCKind: 'category-dispatch-candidates',
    },
  });
  addRelationship(
    graph,
    'DEFINES',
    graphNodeId('File', facts.filePath),
    nodeId,
    `objc: category dispatch candidate evidence: ${message.selector}`,
    1,
  );
  addRelationship(
    graph,
    'USES',
    message.sourceMethodId,
    nodeId,
    `objc-message: category dispatch candidates: ${message.selector}`,
    0.7,
  );
  for (const candidate of candidates) {
    if (graph.getNode(candidate.nodeId) === undefined) continue;
    addRelationship(
      graph,
      'USES',
      nodeId,
      candidate.nodeId,
      `objc-category-dispatch-candidate: ${message.selector}`,
      0.5,
    );
  }
}

function emitProtocolMessageEvidence(
  graph: KnowledgeGraph,
  facts: ObjCFileFacts,
  message: ObjCMessageFact,
  protocolName: string,
  candidates: readonly ObjCMethodFact[],
  workspace: ObjCWorkspaceFacts,
): void {
  if (candidates.length === 0) return;
  const setKey = `${protocolName}\0${message.selector}`;
  const qualifiedName = `objc:protocol-candidates:${protocolName}:${message.selector}`;
  const nodeId = graphNodeId('CodeElement', qualifiedName);
  const protocol = workspace.protocolsByName.get(protocolName);
  const evidenceFilePath = protocol?.filePath ?? facts.filePath;

  if (!workspace.emittedProtocolCandidateSets.has(setKey)) {
    workspace.emittedProtocolCandidateSets.add(setKey);
    graph.addNode({
      id: nodeId,
      label: 'CodeElement',
      properties: {
        name: `[id<${protocolName}> ${message.selector}] protocol implementers`,
        qualifiedName,
        filePath: evidenceFilePath,
        startLine: protocol?.startLine ?? message.startLine,
        endLine: protocol?.endLine ?? message.startLine,
        language: SupportedLanguages.ObjectiveC,
        isExported: false,
        objectiveCKind: 'protocol-implementers',
      },
    });
    addRelationship(
      graph,
      'DEFINES',
      graphNodeId('File', evidenceFilePath),
      nodeId,
      `objc: protocol receiver candidate evidence: ${protocolName} ${message.selector}`,
      1,
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

  addRelationship(
    graph,
    'USES',
    message.sourceMethodId,
    nodeId,
    `objc-message: protocol receiver candidates: ${protocolName} ${message.selector}`,
    0.7,
  );
}
