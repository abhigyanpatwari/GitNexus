import type { GraphNode, ParsedFile, ScopeId } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  resolveCallerGraphId,
  resolveDefGraphId,
} from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { stripBidiAndZeroWidth } from '../../utils/ast-helpers.js';
import { createSpringAnnotationNameResolver } from './bean-candidates.js';
import { SPRING_CONFIG_DESCRIPTION } from './config-bindings.js';

export interface SpringConditionalAnnotationFact {
  readonly name: string;
  readonly text: string;
  readonly line: number;
}

export interface SpringConditionalOwnerFact<
  Annotation extends SpringConditionalAnnotationFact = SpringConditionalAnnotationFact,
> {
  readonly ownerScopeId: ScopeId;
  readonly ownerKind: 'class' | 'callable';
  readonly annotations: readonly Annotation[];
}

export interface SpringConditionalMetadataAdapter<
  Annotation extends SpringConditionalAnnotationFact,
> {
  getFacts(filePath: string): readonly SpringConditionalOwnerFact<Annotation>[];
  isPackageVisibilityIncomplete(filePath: string): boolean;
}

const PROFILE_ANNOTATION = 'org.springframework.context.annotation.Profile';
const CONDITIONAL_ANNOTATION = 'org.springframework.context.annotation.Conditional';
const AUTO_CONFIGURATION_ANNOTATION = 'org.springframework.boot.autoconfigure.AutoConfiguration';

const BOOT_CONDITIONAL_ANNOTATIONS = [
  'ConditionalOnBean',
  'ConditionalOnBooleanProperty',
  'ConditionalOnClass',
  'ConditionalOnCloudPlatform',
  'ConditionalOnExpression',
  'ConditionalOnJava',
  'ConditionalOnJndi',
  'ConditionalOnMissingBean',
  'ConditionalOnMissingClass',
  'ConditionalOnNotWebApplication',
  'ConditionalOnProperty',
  'ConditionalOnResource',
  'ConditionalOnSingleCandidate',
  'ConditionalOnThreading',
  'ConditionalOnWarDeployment',
  'ConditionalOnWebApplication',
] as const;

const CONDITIONAL_ANNOTATIONS = new Set<string>([
  PROFILE_ANNOTATION,
  CONDITIONAL_ANNOTATION,
  ...BOOT_CONDITIONAL_ANNOTATIONS.map(
    (name) => `org.springframework.boot.autoconfigure.condition.${name}`,
  ),
]);

const PROPERTY_CONDITIONAL_ANNOTATIONS = new Set([
  'org.springframework.boot.autoconfigure.condition.ConditionalOnProperty',
  'org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty',
]);

const RESOLVABLE_SPRING_CONDITIONAL_ANNOTATIONS = new Set<string>([
  ...CONDITIONAL_ANNOTATIONS,
  AUTO_CONFIGURATION_ANNOTATION,
]);

const CAPTURE_RELEVANT_SIMPLE_NAMES = new Set([
  'Profile',
  'Conditional',
  'AutoConfiguration',
  ...BOOT_CONDITIONAL_ANNOTATIONS,
]);

function simpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

export function hasSpringConditionalRelevantAnnotation(
  annotations: readonly Pick<SpringConditionalAnnotationFact, 'name'>[],
): boolean {
  return annotations.some((annotation) =>
    CAPTURE_RELEVANT_SIMPLE_NAMES.has(simpleName(annotation.name)),
  );
}

function annotationArguments(text: string): string | undefined {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start === -1 || end <= start) return undefined;
  const args = text.slice(start + 1, end).trim();
  return args.length === 0 ? undefined : args;
}

function splitTopLevelArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;

  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') round++;
    else if (char === ')') round = Math.max(0, round - 1);
    else if (char === '[') square++;
    else if (char === ']') square = Math.max(0, square - 1);
    else if (char === '{') curly++;
    else if (char === '}') curly = Math.max(0, curly - 1);
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

interface ParsedAnnotationArguments {
  readonly positional: readonly string[];
  readonly named: ReadonlyMap<string, string>;
}

function parseArguments(text: string): ParsedAnnotationArguments {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const args = annotationArguments(text);
  if (args === undefined) return { positional, named };
  for (const part of splitTopLevelArguments(args)) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(part);
    if (assignment === null) positional.push(part);
    else {
      const [, name, value] = assignment;
      if (name !== undefined && value !== undefined) named.set(name, value.trim());
    }
  }
  return { positional, named };
}

function decodeStaticString(raw: string): string | undefined {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return undefined;
  }
}

function staticStrings(value: string | undefined): string[] {
  if (value === undefined) return [];
  const values: string[] = [];
  for (let index = 0; index < value.length; ) {
    if (value.startsWith('"""', index)) {
      const end = value.indexOf('"""', index + 3);
      if (end === -1) break;
      const decoded = value.slice(index + 3, end);
      if (!decoded.includes('${')) values.push(decoded);
      index = end + 3;
      continue;
    }
    if (value.charAt(index) !== '"') {
      index++;
      continue;
    }
    let end = index + 1;
    let escaped = false;
    for (; end < value.length; end++) {
      const char = value.charAt(end);
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    if (end >= value.length) break;
    const decoded = decodeStaticString(value.slice(index, end + 1));
    if (decoded !== undefined) values.push(decoded);
    index = end + 1;
  }
  return values;
}

function propertyConditionKeys(annotationText: string): string[] {
  const args = parseArguments(annotationText);
  const prefix = staticStrings(args.named.get('prefix'))[0]?.trim().replace(/\.+$/, '') ?? '';
  const names = staticStrings(
    args.named.get('name') ??
      args.named.get('value') ??
      (args.positional.length > 0 ? args.positional.join(',') : undefined),
  );
  return [
    ...new Set(
      names
        .map((name) => name.replace(/^\.+/, '').trim())
        .filter((name) => name.length > 0)
        .map((name) => (prefix.length > 0 ? `${prefix}.${name}` : name)),
    ),
  ];
}

function conditionDescription(resolvedName: string, annotationText: string): string {
  const args = annotationArguments(annotationText);
  const renderedArgs =
    args === undefined ? '' : `(${args.replace(/\s+/g, ' ').trim().slice(0, 1000)})`;
  return stripBidiAndZeroWidth(
    `Spring condition @${simpleName(resolvedName)}${renderedArgs}; activation unknown`,
  );
}

function ownerGraphNode(
  fact: SpringConditionalOwnerFact,
  indexes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  graph: KnowledgeGraph,
): GraphNode | undefined {
  const ownerScope = indexes.scopeTree.getScope(fact.ownerScopeId);
  if (ownerScope === undefined) return undefined;
  let ownerId: string | undefined;
  if (fact.ownerKind === 'class') {
    const classDef = ownerScope.ownedDefs.find(
      (definition) => definition.type === 'Class' || definition.type === 'Record',
    );
    if (classDef !== undefined) {
      ownerId = resolveDefGraphId(classDef.filePath, classDef, nodeLookup);
    }
  } else {
    ownerId = resolveCallerGraphId(fact.ownerScopeId, indexes, nodeLookup, {
      startLine: fact.annotations[0]?.line ?? ownerScope.range.startLine,
      startCol: 0,
    });
  }
  if (ownerId === undefined) return undefined;
  const owner = graph.getNode(ownerId);
  if (owner === undefined || owner.label === 'File') return undefined;
  return owner;
}

function addConditionNode(
  graph: KnowledgeGraph,
  owner: GraphNode,
  annotation: SpringConditionalAnnotationFact,
  resolvedName: string,
): GraphNode {
  const description = conditionDescription(resolvedName, annotation.text);
  const nodeId = generateId(
    'Annotation',
    `spring-condition:${owner.id}:${annotation.line}:${resolvedName}:${description}`,
  );
  const conditionNode: GraphNode = {
    id: nodeId,
    label: 'Annotation',
    properties: {
      name: `@${simpleName(resolvedName)}`,
      filePath: owner.properties.filePath,
      startLine: annotation.line,
      endLine: annotation.line,
      description,
    },
  };
  graph.addNode(conditionNode);
  const fileId = generateId('File', owner.properties.filePath);
  if (graph.getNode(fileId) !== undefined) {
    graph.addRelationship({
      id: generateId('DEFINES', `${fileId}->${nodeId}`),
      sourceId: fileId,
      targetId: nodeId,
      type: 'DEFINES',
      confidence: 1,
      reason: 'spring-condition:annotation',
    });
  }
  return conditionNode;
}

function addConditionalRelationship(
  graph: KnowledgeGraph,
  owner: GraphNode,
  target: GraphNode,
  annotation: SpringConditionalAnnotationFact,
  resolvedName: string,
  detail?: string,
): void {
  const reason = stripBidiAndZeroWidth(
    [`spring-condition:@${simpleName(resolvedName)}`, detail, 'activation=unknown']
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(' '),
  );
  graph.addRelationship({
    id: generateId(
      'CONDITIONAL_ON',
      `${owner.id}->${target.id}:${annotation.line}:${resolvedName}:${detail ?? ''}`,
    ),
    sourceId: owner.id,
    targetId: target.id,
    type: 'CONDITIONAL_ON',
    confidence: 1,
    reason,
  });
}

function addAutoConfigurationRelationship(
  graph: KnowledgeGraph,
  owner: GraphNode,
  annotation: SpringConditionalAnnotationFact,
): void {
  const fileId = generateId('File', owner.properties.filePath);
  if (graph.getNode(fileId) === undefined) return;
  graph.addRelationship({
    id: generateId('AUTO_REGISTERS', `${fileId}->${owner.id}:annotation:${annotation.line}`),
    sourceId: fileId,
    targetId: owner.id,
    type: 'AUTO_REGISTERS',
    confidence: 1,
    reason: 'spring-auto-configuration:@AutoConfiguration',
  });
}

const configNodesByGraph = new WeakMap<KnowledgeGraph, ReadonlyMap<string, readonly GraphNode[]>>();

function configNodesByKey(graph: KnowledgeGraph): ReadonlyMap<string, readonly GraphNode[]> {
  const cached = configNodesByGraph.get(graph);
  if (cached !== undefined) return cached;
  const byKey = new Map<string, GraphNode[]>();
  for (const node of graph.iterNodes()) {
    if (
      node.label !== 'Property' ||
      typeof node.properties.description !== 'string' ||
      !node.properties.description.startsWith(SPRING_CONFIG_DESCRIPTION)
    ) {
      continue;
    }
    const key = String(node.properties.name);
    const bucket = byKey.get(key) ?? [];
    bucket.push(node);
    byKey.set(key, bucket);
  }
  configNodesByGraph.set(graph, byKey);
  return byKey;
}

/**
 * Build a post-resolution Spring conditional attacher shared by language
 * adapters. Adapters capture syntax and package-visibility facts; this module
 * owns framework annotation semantics and graph representation.
 */
export function createSpringConditionalMetadataAttacher<
  Annotation extends SpringConditionalAnnotationFact,
>(adapter: SpringConditionalMetadataAdapter<Annotation>) {
  return (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    indexes: ScopeResolutionIndexes,
  ): void => {
    const resolveAnnotation = createSpringAnnotationNameResolver(indexes);
    let propertyNodes: ReadonlyMap<string, readonly GraphNode[]> | undefined;

    for (const parsed of parsedFiles) {
      const incomplete = adapter.isPackageVisibilityIncomplete(parsed.filePath);
      const resolvedAnnotations = new Map<string, string | undefined>();
      for (const fact of adapter.getFacts(parsed.filePath)) {
        const owner = ownerGraphNode(fact, indexes, nodeLookup, graph);
        const ownerScope = indexes.scopeTree.getScope(fact.ownerScopeId);
        if (owner === undefined || ownerScope === undefined) continue;

        for (const annotation of fact.annotations) {
          const cacheKey = `${ownerScope.parent ?? '<root>'}\0${annotation.name}`;
          let resolved = resolvedAnnotations.get(cacheKey);
          if (!resolvedAnnotations.has(cacheKey)) {
            resolved = resolveAnnotation(
              annotation.name,
              parsed,
              ownerScope.parent,
              RESOLVABLE_SPRING_CONDITIONAL_ANNOTATIONS,
              incomplete,
            );
            resolvedAnnotations.set(cacheKey, resolved);
          }
          if (resolved === undefined) continue;
          if (resolved === AUTO_CONFIGURATION_ANNOTATION && owner.label === 'Class') {
            addAutoConfigurationRelationship(graph, owner, annotation);
            continue;
          }
          if (!CONDITIONAL_ANNOTATIONS.has(resolved)) continue;

          if (PROPERTY_CONDITIONAL_ANNOTATIONS.has(resolved)) {
            const keys = propertyConditionKeys(annotation.text);
            propertyNodes ??= configNodesByKey(graph);
            let matched = false;
            for (const key of keys) {
              for (const property of propertyNodes.get(key) ?? []) {
                matched = true;
                addConditionalRelationship(
                  graph,
                  owner,
                  property,
                  annotation,
                  resolved,
                  `key=${key}`,
                );
              }
            }
            if (matched) continue;
          }

          const conditionNode = addConditionNode(graph, owner, annotation, resolved);
          addConditionalRelationship(graph, owner, conditionNode, annotation, resolved);
        }
      }
    }
  };
}
