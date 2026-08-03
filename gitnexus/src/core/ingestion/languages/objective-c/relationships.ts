import type {
  GraphRelationship,
  ParsedFile,
  RelationshipType,
  SymbolDefinition,
} from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';

import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';
import { sourceIdentityIdTag } from '../../utils/source-identity.js';
import { objectiveCKeyV1, objectiveCSourceIdentity } from './identity.js';

interface DefinitionEntry {
  readonly parsed: ParsedFile;
  readonly definition: SymbolDefinition;
}

const annotationValue = (
  definition: SymbolDefinition,
  prefix: string,
): string | undefined =>
  definition.annotations?.find((annotation) => annotation.startsWith(prefix))?.slice(prefix.length);

const hasAnnotation = (definition: SymbolDefinition, value: string): boolean =>
  definition.annotations?.includes(value) ?? false;

const isPropertyDirective = (definition: SymbolDefinition): boolean =>
  definition.annotations?.some((annotation) =>
    annotation.startsWith('objc:property-implementation:'),
  ) ?? false;

const sourceRole = (definition: SymbolDefinition): string | undefined =>
  annotationValue(definition, 'objc:site:');

const ownerName = (definition: SymbolDefinition): string | undefined =>
  annotationValue(definition, 'objc:owner:');

const categoryName = (definition: SymbolDefinition): string | undefined =>
  annotationValue(definition, 'objc:category:');

const simpleName = (definition: SymbolDefinition): string => {
  const qualified = definition.qualifiedName ?? '';
  const separator = qualified.lastIndexOf('.');
  return separator === -1 ? qualified : qualified.slice(separator + 1);
};

const sourceScope = (definition: SymbolDefinition): string =>
  categoryName(definition) ??
  (hasAnnotation(definition, 'objc:class-extension') ? '<extension>' : '<primary>');

const declarationScope = (definition: SymbolDefinition): string =>
  categoryName(definition) ?? '<primary>';

function collectDefinitions(parsedFiles: readonly ParsedFile[]): DefinitionEntry[] {
  return parsedFiles.flatMap((parsed) =>
    parsed.localDefs.map((definition) => ({ parsed, definition })),
  );
}

function uniqueByOwner(entries: readonly DefinitionEntry[]): ReadonlyMap<string, DefinitionEntry> {
  const candidates = new Map<string, DefinitionEntry | null>();
  for (const entry of entries) {
    const owner = ownerName(entry.definition);
    if (owner === undefined) continue;
    const existing = candidates.get(owner);
    candidates.set(owner, existing === undefined ? entry : null);
  }
  const result = new Map<string, DefinitionEntry>();
  for (const [owner, entry] of candidates) {
    if (entry !== null) result.set(owner, entry);
  }
  return result;
}

function relationshipEmitter(graph: KnowledgeGraph): (
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  reason: string,
  confidence?: number,
) => void {
  const existing = new Set<string>();
  for (const relationship of graph.iterRelationships()) {
    existing.add(`${relationship.type}:${relationship.sourceId}->${relationship.targetId}`);
  }
  return (type, sourceId, targetId, reason, confidence = 1): void => {
    const key = `${type}:${sourceId}->${targetId}`;
    if (existing.has(key)) return;
    existing.add(key);
    graph.addRelationship({
      id: generateId(type, `${sourceId}->${targetId}`),
      sourceId,
      targetId,
      type,
      confidence,
      reason,
    });
  };
}

function removeDanglingObjectiveCContainment(graph: KnowledgeGraph): void {
  const stale: GraphRelationship[] = [];
  for (const type of ['HAS_METHOD', 'HAS_PROPERTY'] as const) {
    for (const relationship of graph.iterRelationshipsByType(type)) {
      const target = graph.getNode(relationship.targetId);
      if (
        graph.getNode(relationship.sourceId) === undefined &&
        target?.properties.language === SupportedLanguages.ObjectiveC
      ) {
        stale.push(relationship);
      }
    }
  }
  for (const relationship of stale) graph.removeRelationship(relationship.id);
}

function graphNodeBySourceIdentity(graph: KnowledgeGraph): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    const sourceIdentity = node.properties.sourceIdentity;
    if (typeof sourceIdentity !== 'string' || sourceIdentity.length === 0) continue;
    result.set(`${node.properties.filePath}\0${node.label}\0${sourceIdentity}`, node.id);
  }
  return result;
}

function resolveEntry(
  entry: DefinitionEntry,
  nodeLookup: GraphNodeLookup,
  bySourceIdentity: ReadonlyMap<string, string>,
): string | undefined {
  const { definition } = entry;
  if (definition.sourceIdentity !== undefined) {
    const exact = bySourceIdentity.get(
      `${entry.parsed.filePath}\0${definition.type}\0${definition.sourceIdentity}`,
    );
    if (exact !== undefined) return exact;
  }
  return resolveDefGraphId(entry.parsed.filePath, definition, nodeLookup);
}

function matchingSourceContainer(
  member: DefinitionEntry,
  containers: readonly DefinitionEntry[],
): DefinitionEntry | undefined {
  const { definition } = member;
  const owner = ownerName(definition);
  if (owner === undefined) return undefined;
  const isProtocolMember = annotationValue(definition, 'objc:protocol:') !== undefined;
  const memberRole = sourceRole(definition);
  const category = categoryName(definition);
  const isExtension = hasAnnotation(definition, 'objc:class-extension');

  return containers.find((candidate) => {
    if (candidate.parsed.filePath !== member.parsed.filePath) return false;
    if (ownerName(candidate.definition) !== owner) return false;
    if (isProtocolMember) {
      return candidate.definition.type === 'Interface' && sourceRole(candidate.definition) === memberRole;
    }
    if (candidate.definition.type !== 'Class') return false;
    if (category !== undefined || isExtension) {
      return (
        sourceRole(candidate.definition) === 'category-host' &&
        categoryName(candidate.definition) === category &&
        hasAnnotation(candidate.definition, 'objc:class-extension') === isExtension
      );
    }
    return sourceRole(candidate.definition) === memberRole;
  });
}

function emitSourceSiteContainment(
  entries: readonly DefinitionEntry[],
  graph: KnowledgeGraph,
  nodeLookup: GraphNodeLookup,
  bySourceIdentity: ReadonlyMap<string, string>,
  emit: ReturnType<typeof relationshipEmitter>,
): void {
  const containers = entries.filter(
    (entry) => entry.definition.type === 'Class' || entry.definition.type === 'Interface',
  );
  for (const entry of entries) {
    const { definition } = entry;
    if (
      definition.type !== 'Method' &&
      definition.type !== 'Property' &&
      definition.type !== 'Variable'
    ) {
      continue;
    }
    if (definition.type === 'Property' && isPropertyDirective(definition)) continue;
    if (sourceRole(definition) === 'synthesized') continue;
    const container = matchingSourceContainer(entry, containers);
    if (container === undefined) continue;
    const sourceId = resolveEntry(container, nodeLookup, bySourceIdentity);
    const targetId = resolveEntry(entry, nodeLookup, bySourceIdentity);
    if (sourceId === undefined || targetId === undefined) continue;
    emit(
      definition.type === 'Method' ? 'HAS_METHOD' : 'HAS_PROPERTY',
      sourceId,
      targetId,
      'objective-c: source-site containment',
    );
  }
}

function syntheticMethodId(
  entry: DefinitionEntry,
  filePath: string,
  sourceIdentity: string,
): string {
  const { definition } = entry;
  const arity = definition.parameterCount ?? 0;
  return generateId(
    'Method',
    `${filePath}:${definition.qualifiedName ?? simpleName(definition)}#${arity}${sourceIdentityIdTag(sourceIdentity)}`,
  );
}

function emitSyntheticPropertyAccessors(
  entries: readonly DefinitionEntry[],
  primaryImplementations: ReadonlyMap<string, DefinitionEntry>,
  graph: KnowledgeGraph,
  nodeLookup: GraphNodeLookup,
  bySourceIdentity: ReadonlyMap<string, string>,
  emit: ReturnType<typeof relationshipEmitter>,
): void {
  const explicitImplementationKeys = new Set<string>();
  const dynamicProperties = new Set<string>();
  for (const entry of entries) {
    const { definition } = entry;
    if (
      definition.type === 'Property' &&
      hasAnnotation(definition, 'objc:property-implementation:dynamic')
    ) {
      const owner = ownerName(definition);
      if (owner !== undefined) dynamicProperties.add(`${owner}\0${simpleName(definition)}`);
    }
    if (definition.type !== 'Method' || sourceRole(definition) !== 'implementation') continue;
    const owner = ownerName(definition);
    if (owner !== undefined) explicitImplementationKeys.add(`${owner}\0${simpleName(definition)}`);
  }

  const selected = new Map<string, DefinitionEntry>();
  for (const entry of entries) {
    const { definition } = entry;
    if (
      definition.type !== 'Method' ||
      sourceRole(definition) !== 'synthesized' ||
      !hasAnnotation(definition, 'objc:property-accessor')
    ) {
      continue;
    }
    const owner = ownerName(definition);
    if (owner === undefined) continue;
    const propertyName = annotationValue(definition, 'objc:property-name:');
    if (
      propertyName === undefined ||
      dynamicProperties.has(`${owner}\0${propertyName}`) ||
      definition.annotations?.some((annotation) => annotation.startsWith('objc:protocol:')) ||
      categoryName(definition) !== undefined
    ) {
      continue;
    }
    const key = `${owner}\0${simpleName(definition)}`;
    if (explicitImplementationKeys.has(key) || selected.has(key)) continue;
    selected.set(key, entry);
  }

  for (const [dispatch, entry] of selected) {
    const { definition } = entry;
    const owner = dispatch.slice(0, dispatch.indexOf('\0'));
    const concreteClass = primaryImplementations.get(owner);
    if (concreteClass === undefined) continue;
    const classId = resolveEntry(concreteClass, nodeLookup, bySourceIdentity);
    if (classId === undefined) continue;
    const sourceIdentity = objectiveCSourceIdentity({
      label: 'Method',
      owner,
      declarationScope: '<primary>',
      sourceRole: 'synthesized',
      member: simpleName(definition),
    });
    const methodId = syntheticMethodId(entry, concreteClass.parsed.filePath, sourceIdentity);
    const position = definitionIdPosition(
      concreteClass.definition.nodeId,
      concreteClass.parsed.filePath,
    );
    const annotations = [
      ...(definition.annotations ?? []).filter((annotation) => !annotation.startsWith('objc:site:')),
      'objc:site:synthesized',
    ];
    graph.addNode({
      id: methodId,
      label: 'Method',
      properties: {
        name: simpleName(definition),
        qualifiedName: definition.qualifiedName,
        filePath: concreteClass.parsed.filePath,
        startLine: position === undefined ? undefined : Math.max(0, position.line - 1),
        endLine: position === undefined ? undefined : Math.max(0, position.line - 1),
        language: SupportedLanguages.ObjectiveC,
        parameterCount: definition.parameterCount ?? 0,
        parameterTypes: definition.parameterTypes ?? [],
        returnType: definition.returnType,
        isStatic: definition.isStatic ?? false,
        annotations,
        sourceIdentity,
        sourceRole: 'synthesized',
        selector: simpleName(definition).slice(1),
        dispatchKey: objectiveCKeyV1(['dispatch', owner, simpleName(definition)]),
      },
    });
    emit('HAS_METHOD', classId, methodId, 'objective-c: synthesized property accessor');
  }
}

function primaryPropertyDeclarations(entries: readonly DefinitionEntry[]): ReadonlyMap<string, DefinitionEntry> {
  const candidates = new Map<string, DefinitionEntry | null>();
  for (const entry of entries) {
    const { definition } = entry;
    if (
      definition.type !== 'Property' ||
      sourceRole(definition) !== 'declaration' ||
      isPropertyDirective(definition) ||
      categoryName(definition) !== undefined ||
      definition.annotations?.some((annotation) => annotation.startsWith('objc:protocol:'))
    ) {
      continue;
    }
    const owner = ownerName(definition);
    if (owner === undefined) continue;
    const key = `${owner}\0${simpleName(definition)}`;
    const existing = candidates.get(key);
    candidates.set(key, existing === undefined ? entry : null);
  }
  const result = new Map<string, DefinitionEntry>();
  for (const [key, entry] of candidates) {
    if (entry !== null) result.set(key, entry);
  }
  return result;
}

function emitPropertyRuntimeState(
  entries: readonly DefinitionEntry[],
  primaryImplementations: ReadonlyMap<string, DefinitionEntry>,
  graph: KnowledgeGraph,
  nodeLookup: GraphNodeLookup,
  bySourceIdentity: ReadonlyMap<string, string>,
  emit: ReturnType<typeof relationshipEmitter>,
): void {
  const directives = new Map<string, { kind: 'dynamic' | 'synthesize'; backing?: string }>();
  for (const entry of entries) {
    const { definition } = entry;
    if (definition.type !== 'Property' || !isPropertyDirective(definition)) continue;
    const owner = ownerName(definition);
    if (owner === undefined) continue;
    const key = `${owner}\0${simpleName(definition)}`;
    if (hasAnnotation(definition, 'objc:property-implementation:dynamic')) {
      directives.set(key, { kind: 'dynamic' });
    } else if (hasAnnotation(definition, 'objc:property-implementation:synthesize')) {
      directives.set(key, {
        kind: 'synthesize',
        backing: annotationValue(definition, 'objc:backing-ivar:'),
      });
    }
  }

  const explicitIvars = new Set<string>();
  for (const entry of entries) {
    if (entry.definition.type !== 'Variable' || !hasAnnotation(entry.definition, 'objc:ivar')) continue;
    const owner = ownerName(entry.definition);
    if (owner !== undefined) explicitIvars.add(`${owner}\0${simpleName(entry.definition)}`);
  }

  for (const [key, property] of primaryPropertyDeclarations(entries)) {
    const separator = key.indexOf('\0');
    const owner = key.slice(0, separator);
    const propertyName = key.slice(separator + 1);
    const implementation = primaryImplementations.get(owner);
    if (implementation === undefined) continue;
    const classId = resolveEntry(implementation, nodeLookup, bySourceIdentity);
    const propertyId = resolveEntry(property, nodeLookup, bySourceIdentity);
    if (classId === undefined) continue;
    if (propertyId !== undefined) {
      emit('HAS_PROPERTY', classId, propertyId, 'objective-c: runtime property');
    }

    const directive = directives.get(key);
    if (directive?.kind === 'dynamic') {
      const propertyNode = propertyId === undefined ? undefined : graph.getNode(propertyId);
      if (propertyNode !== undefined) {
        const annotations = Array.isArray(propertyNode.properties.annotations)
          ? propertyNode.properties.annotations.filter(
              (annotation): annotation is string => typeof annotation === 'string',
            )
          : [];
        if (!annotations.includes('objc:property:dynamic')) {
          propertyNode.properties.annotations = [...annotations, 'objc:property:dynamic'];
        }
      }
      continue;
    }
    if (property.definition.isStatic === true) continue;

    const backing = directive?.backing ?? `_${propertyName}`;
    if (explicitIvars.has(`${owner}\0${backing}`)) continue;
    const sourceIdentity = objectiveCSourceIdentity({
      label: 'Variable',
      owner,
      declarationScope: '<primary>',
      sourceRole: 'synthesized',
      member: backing,
    });
    const ivarId = generateId(
      'Variable',
      `${implementation.parsed.filePath}:${backing}${sourceIdentityIdTag(sourceIdentity)}`,
    );
    const position = definitionIdPosition(
      implementation.definition.nodeId,
      implementation.parsed.filePath,
    );
    graph.addNode({
      id: ivarId,
      label: 'Variable',
      properties: {
        name: backing,
        qualifiedName: `${owner}.${backing}`,
        filePath: implementation.parsed.filePath,
        startLine: position === undefined ? undefined : Math.max(0, position.line - 1),
        endLine: position === undefined ? undefined : Math.max(0, position.line - 1),
        language: SupportedLanguages.ObjectiveC,
        declaredType: property.definition.declaredType,
        annotations: [
          'objc:site:synthesized',
          `objc:owner:${owner}`,
          'objc:ivar',
          `objc:property-name:${propertyName}`,
        ],
        sourceIdentity,
        sourceRole: 'synthesized',
      },
    });
    emit('HAS_PROPERTY', classId, ivarId, 'objective-c: synthesized backing ivar');
  }
}

function emitDeclarationLinks(
  entries: readonly DefinitionEntry[],
  primaryImplementations: ReadonlyMap<string, DefinitionEntry>,
  graph: KnowledgeGraph,
  nodeLookup: GraphNodeLookup,
  bySourceIdentity: ReadonlyMap<string, string>,
  emit: ReturnType<typeof relationshipEmitter>,
): readonly { declarationId: string; implementationId: string }[] {
  const classLinks: { declarationId: string; implementationId: string }[] = [];
  for (const entry of entries) {
    const { definition } = entry;
    if (
      definition.type !== 'Class' ||
      sourceRole(definition) !== 'declaration' ||
      categoryName(definition) !== undefined ||
      hasAnnotation(definition, 'objc:class-extension')
    ) {
      continue;
    }
    const owner = ownerName(definition);
    const implementation = owner === undefined ? undefined : primaryImplementations.get(owner);
    if (implementation === undefined) continue;
    const declarationId = resolveEntry(entry, nodeLookup, bySourceIdentity);
    const implementationId = resolveEntry(implementation, nodeLookup, bySourceIdentity);
    if (declarationId === undefined || implementationId === undefined) continue;
    emit('DECLARES', declarationId, implementationId, 'objective-c: declaration-to-definition');
    classLinks.push({ declarationId, implementationId });
  }

  const implementationsByKey = new Map<string, DefinitionEntry[]>();
  for (const entry of entries) {
    const { definition } = entry;
    if (definition.type !== 'Method' || sourceRole(definition) !== 'implementation') continue;
    const owner = ownerName(definition);
    if (owner === undefined) continue;
    const key = `${owner}\0${declarationScope(definition)}\0${simpleName(definition)}`;
    const group = implementationsByKey.get(key) ?? [];
    group.push(entry);
    implementationsByKey.set(key, group);
  }
  for (const entry of entries) {
    const { definition } = entry;
    if (
      definition.type !== 'Method' ||
      sourceRole(definition) !== 'declaration' ||
      hasAnnotation(definition, 'objc:property-accessor')
    ) {
      continue;
    }
    const owner = ownerName(definition);
    if (owner === undefined) continue;
    const candidates = implementationsByKey.get(
      `${owner}\0${declarationScope(definition)}\0${simpleName(definition)}`,
    );
    if (candidates?.length !== 1) continue;
    const declarationId = resolveEntry(entry, nodeLookup, bySourceIdentity);
    const implementationId = resolveEntry(candidates[0]!, nodeLookup, bySourceIdentity);
    if (declarationId === undefined || implementationId === undefined) continue;
    emit('DECLARES', declarationId, implementationId, 'objective-c: declaration-to-definition');
  }
  return classLinks;
}

function emitCategoryModel(
  entries: readonly DefinitionEntry[],
  primaryImplementations: ReadonlyMap<string, DefinitionEntry>,
  nodeLookup: GraphNodeLookup,
  bySourceIdentity: ReadonlyMap<string, string>,
  emit: ReturnType<typeof relationshipEmitter>,
): void {
  const hosts = entries.filter(
    (entry) =>
      entry.definition.type === 'Class' && sourceRole(entry.definition) === 'category-host',
  );
  const methods = entries.filter((entry) => entry.definition.type === 'Method');
  for (const element of entries.filter((entry) => entry.definition.type === 'CodeElement')) {
    const owner = ownerName(element.definition);
    if (owner === undefined) continue;
    const category = sourceScope(element.definition);
    const host = hosts.find(
      (candidate) =>
        candidate.parsed.filePath === element.parsed.filePath &&
        ownerName(candidate.definition) === owner &&
        sourceScope(candidate.definition) === category,
    );
    const hostId = host === undefined ? undefined : resolveEntry(host, nodeLookup, bySourceIdentity);
    const elementId = resolveEntry(element, nodeLookup, bySourceIdentity);
    if (hostId !== undefined && elementId !== undefined) {
      emit('DECLARES', hostId, elementId, 'objective-c: category-extension');
    }
    if (elementId === undefined) continue;
    for (const method of methods) {
      if (method.parsed.filePath !== element.parsed.filePath) continue;
      if (ownerName(method.definition) !== owner) continue;
      if (sourceScope(method.definition) !== category) continue;
      if (sourceRole(method.definition) !== sourceRole(element.definition)) continue;
      const methodId = resolveEntry(method, nodeLookup, bySourceIdentity);
      if (methodId !== undefined) {
        emit('DECLARES', elementId, methodId, 'objective-c: category-extension');
      }
    }
  }

  const implementationsByDispatch = new Map<string, DefinitionEntry[]>();
  for (const method of methods) {
    if (sourceRole(method.definition) !== 'implementation') continue;
    const owner = ownerName(method.definition);
    if (owner === undefined) continue;
    const key = `${owner}\0${simpleName(method.definition)}`;
    const group = implementationsByDispatch.get(key) ?? [];
    group.push(method);
    implementationsByDispatch.set(key, group);
  }
  for (const [dispatch, implementations] of implementationsByDispatch) {
    if (implementations.length !== 1) continue;
    const implementation = implementations[0]!;
    if (categoryName(implementation.definition) === undefined) continue;
    const owner = dispatch.slice(0, dispatch.indexOf('\0'));
    const concreteClass = primaryImplementations.get(owner);
    if (concreteClass === undefined) continue;
    const classId = resolveEntry(concreteClass, nodeLookup, bySourceIdentity);
    const methodId = resolveEntry(implementation, nodeLookup, bySourceIdentity);
    if (classId !== undefined && methodId !== undefined) {
      emit('HAS_METHOD', classId, methodId, 'objective-c: unique category dispatch', 0.9);
    }
  }
}

function emitIvarRuntimeContainment(
  entries: readonly DefinitionEntry[],
  primaryImplementations: ReadonlyMap<string, DefinitionEntry>,
  nodeLookup: GraphNodeLookup,
  bySourceIdentity: ReadonlyMap<string, string>,
  emit: ReturnType<typeof relationshipEmitter>,
): void {
  for (const entry of entries) {
    if (entry.definition.type !== 'Variable' || !hasAnnotation(entry.definition, 'objc:ivar')) {
      continue;
    }
    const owner = ownerName(entry.definition);
    const concreteClass = owner === undefined ? undefined : primaryImplementations.get(owner);
    if (concreteClass === undefined) continue;
    const classId = resolveEntry(concreteClass, nodeLookup, bySourceIdentity);
    const ivarId = resolveEntry(entry, nodeLookup, bySourceIdentity);
    if (classId !== undefined && ivarId !== undefined) {
      emit('HAS_PROPERTY', classId, ivarId, 'objective-c: ivar');
    }
  }
}

function mirrorHeritage(
  graph: KnowledgeGraph,
  classLinks: readonly { declarationId: string; implementationId: string }[],
  emit: ReturnType<typeof relationshipEmitter>,
): void {
  const heritage = [...graph.iterRelationshipsByType('EXTENDS'), ...graph.iterRelationshipsByType('IMPLEMENTS')];
  for (const link of classLinks) {
    for (const relationship of heritage) {
      if (relationship.sourceId !== link.declarationId) continue;
      emit(
        relationship.type,
        link.implementationId,
        relationship.targetId,
        'objective-c: declaration-to-definition',
        relationship.confidence,
      );
    }
  }
}

/** Emit Objective-C source-site and runtime relations before shared MRO construction. */
export function emitObjectiveCSourceSiteEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  removeDanglingObjectiveCContainment(graph);
  const entries = collectDefinitions(parsedFiles);
  const bySourceIdentity = graphNodeBySourceIdentity(graph);
  const emit = relationshipEmitter(graph);
  const primaryImplementations = uniqueByOwner(
    entries.filter(
      (entry) =>
        entry.definition.type === 'Class' &&
        sourceRole(entry.definition) === 'implementation' &&
        categoryName(entry.definition) === undefined &&
        !hasAnnotation(entry.definition, 'objc:class-extension'),
    ),
  );

  emitSourceSiteContainment(entries, graph, nodeLookup, bySourceIdentity, emit);
  emitSyntheticPropertyAccessors(
    entries,
    primaryImplementations,
    graph,
    nodeLookup,
    bySourceIdentity,
    emit,
  );
  emitPropertyRuntimeState(
    entries,
    primaryImplementations,
    graph,
    nodeLookup,
    bySourceIdentity,
    emit,
  );
  emitIvarRuntimeContainment(entries, primaryImplementations, nodeLookup, bySourceIdentity, emit);
  const classLinks = emitDeclarationLinks(
    entries,
    primaryImplementations,
    graph,
    nodeLookup,
    bySourceIdentity,
    emit,
  );
  emitCategoryModel(entries, primaryImplementations, nodeLookup, bySourceIdentity, emit);
  mirrorHeritage(graph, classLinks, emit);
}
