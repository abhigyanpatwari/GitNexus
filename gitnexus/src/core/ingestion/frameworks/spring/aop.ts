import type { GraphNode, GraphRelationship, ParsedFile, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  resolveCallerGraphId,
  resolveDefGraphId,
} from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { stripBidiAndZeroWidth } from '../../utils/ast-helpers.js';
import {
  parseSpringAnnotationArguments,
  parseStaticStringLiteral,
} from './annotation-arguments.js';
import { createSpringAnnotationNameResolver } from './bean-candidates.js';

export const SPRING_AOP_REASON_PREFIX = 'spring-aop:v1:';
export const SPRING_AOP_EVIDENCE_DESCRIPTION_PREFIX = 'Spring AOP: ';
export const SPRING_AOP_EVIDENCE_ID_PREFIX = 'CodeElement:spring-aop:';
const MAX_POINTCUT_LENGTH = 1_000;

export type SpringAopBehavior =
  | 'transactional'
  | 'caching'
  | 'cacheable'
  | 'cache-evict'
  | 'cache-put'
  | 'authorization';

export type SpringAopAdviceKind =
  | 'around'
  | 'before'
  | 'after'
  | 'after-returning'
  | 'after-throwing'
  | 'pointcut';

export interface SpringAopAnnotationFact {
  readonly name: string;
  readonly text: string;
  readonly line: number;
  /** Kotlin use-site targets do not describe a callable annotation here. */
  readonly useSiteTarget?: string;
}

export interface SpringAopOwnerFact<
  Annotation extends SpringAopAnnotationFact = SpringAopAnnotationFact,
> {
  readonly ownerScopeId: ScopeId;
  readonly ownerKind: 'class' | 'callable';
  /** The language models this class's members as static, but they are singleton instance methods. */
  readonly singletonInstance?: true;
  readonly annotations: readonly Annotation[];
}

export interface SpringAopMetadataAdapter<Annotation extends SpringAopAnnotationFact> {
  getFacts(filePath: string): readonly SpringAopOwnerFact<Annotation>[];
  isPackageVisibilityIncomplete(filePath: string): boolean;
}

export interface SpringAopBehaviorReason {
  readonly kind: 'behavior';
  readonly annotation: string;
  readonly behavior: SpringAopBehavior;
  readonly declaredOn: 'class' | 'method';
  readonly activation: 'unknown';
  readonly proxy: 'possible';
}

export interface SpringAopAdviceReason {
  readonly kind: 'advice';
  readonly annotation: string;
  readonly advice: Exclude<SpringAopAdviceKind, 'pointcut'>;
  readonly pointcut: string;
  readonly match: 'static';
  readonly activation: 'unknown';
  readonly proxy: 'possible';
}

export interface SpringAopPointcutReason {
  readonly kind: 'pointcut';
  readonly annotation: string;
  readonly pointcut: string | null;
  readonly match: 'static' | 'unresolved';
  readonly resolution: 'resolved' | 'unknown';
}

export interface SpringAopAspectReason {
  readonly kind: 'aspect';
  readonly annotation: string;
  readonly activation: 'unknown';
  readonly registration: 'unknown';
}

export type SpringAopReason =
  | SpringAopBehaviorReason
  | SpringAopAdviceReason
  | SpringAopPointcutReason
  | SpringAopAspectReason;

export interface SpringAopAspectRecord {
  readonly ownerId: string;
  readonly annotation: string;
  readonly line: number;
}

export interface SpringAopBehaviorRecord {
  readonly ownerId: string;
  readonly ownerKind: 'class' | 'callable';
  readonly annotation: string;
  readonly behavior: SpringAopBehavior;
  readonly line: number;
}

export interface SpringAopAdviceRecord {
  readonly ownerId: string;
  readonly annotation: string;
  readonly advice: SpringAopAdviceKind;
  readonly pointcut: string | null;
  readonly line: number;
}

export interface SpringAopGraphMetadata {
  readonly candidateFilePaths: ReadonlySet<string>;
  readonly aspectClassIds: ReadonlySet<string>;
  readonly singletonInstanceClassIds: ReadonlySet<string>;
  readonly aspects: readonly SpringAopAspectRecord[];
  readonly behaviors: readonly SpringAopBehaviorRecord[];
  readonly advices: readonly SpringAopAdviceRecord[];
}

interface MutableSpringAopGraphMetadata {
  readonly candidateFilePaths: Set<string>;
  readonly aspectClassIds: Set<string>;
  readonly singletonInstanceClassIds: Set<string>;
  readonly aspects: SpringAopAspectRecord[];
  readonly behaviors: SpringAopBehaviorRecord[];
  readonly advices: SpringAopAdviceRecord[];
}

const metadataByGraph = new WeakMap<KnowledgeGraph, MutableSpringAopGraphMetadata>();

function graphMetadata(graph: KnowledgeGraph): MutableSpringAopGraphMetadata {
  let metadata = metadataByGraph.get(graph);
  if (metadata === undefined) {
    metadata = {
      candidateFilePaths: new Set(),
      aspectClassIds: new Set(),
      singletonInstanceClassIds: new Set(),
      aspects: [],
      behaviors: [],
      advices: [],
    };
    metadataByGraph.set(graph, metadata);
  }
  return metadata;
}

export function getSpringAopGraphMetadata(graph: KnowledgeGraph): SpringAopGraphMetadata {
  return graphMetadata(graph);
}

const ASPECT_ANNOTATION = 'org.aspectj.lang.annotation.Aspect';

const BEHAVIOR_ANNOTATIONS = new Map<string, SpringAopBehavior>([
  ['org.springframework.transaction.annotation.Transactional', 'transactional'],
  ['jakarta.transaction.Transactional', 'transactional'],
  ['javax.transaction.Transactional', 'transactional'],
  ['org.springframework.cache.annotation.Cacheable', 'cacheable'],
  ['org.springframework.cache.annotation.CacheEvict', 'cache-evict'],
  ['org.springframework.cache.annotation.CachePut', 'cache-put'],
  ['org.springframework.cache.annotation.Caching', 'caching'],
  ['org.springframework.security.access.prepost.PreAuthorize', 'authorization'],
  ['org.springframework.security.access.prepost.PostAuthorize', 'authorization'],
  ['org.springframework.security.access.prepost.PreFilter', 'authorization'],
  ['org.springframework.security.access.prepost.PostFilter', 'authorization'],
  ['org.springframework.security.access.annotation.Secured', 'authorization'],
  ['jakarta.annotation.security.RolesAllowed', 'authorization'],
  ['javax.annotation.security.RolesAllowed', 'authorization'],
]);

const ADVICE_ANNOTATIONS = new Map<string, SpringAopAdviceKind>([
  ['org.aspectj.lang.annotation.Around', 'around'],
  ['org.aspectj.lang.annotation.Before', 'before'],
  ['org.aspectj.lang.annotation.After', 'after'],
  ['org.aspectj.lang.annotation.AfterReturning', 'after-returning'],
  ['org.aspectj.lang.annotation.AfterThrowing', 'after-throwing'],
  ['org.aspectj.lang.annotation.Pointcut', 'pointcut'],
]);

const RECOGNIZED_AOP_ANNOTATIONS = new Set<string>([
  ASPECT_ANNOTATION,
  ...BEHAVIOR_ANNOTATIONS.keys(),
  ...ADVICE_ANNOTATIONS.keys(),
]);

const CAPTURE_RELEVANT_SIMPLE_NAMES = new Set(
  [...RECOGNIZED_AOP_ANNOTATIONS].map((name) => simpleName(name)),
);

function simpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

export function hasSpringAopRelevantAnnotation(
  annotations: readonly Pick<SpringAopAnnotationFact, 'name'>[],
): boolean {
  return annotations.some((annotation) =>
    CAPTURE_RELEVANT_SIMPLE_NAMES.has(simpleName(annotation.name)),
  );
}

function ownerGraphNode(
  fact: SpringAopOwnerFact,
  indexes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  graph: KnowledgeGraph,
): GraphNode | undefined {
  const ownerScope = indexes.scopeTree.getScope(fact.ownerScopeId);
  if (ownerScope === undefined) return undefined;

  let ownerId: string | undefined;
  if (fact.ownerKind === 'class') {
    const classDef = ownerScope.ownedDefs.find(
      (definition) => definition.type === 'Class' || definition.type === 'Interface',
    );
    if (classDef !== undefined)
      ownerId = resolveDefGraphId(classDef.filePath, classDef, nodeLookup);
  } else {
    ownerId = resolveCallerGraphId(fact.ownerScopeId, indexes, nodeLookup);
  }

  if (ownerId === undefined) return undefined;
  const owner = graph.getNode(ownerId);
  return owner === undefined || owner.label === 'File' ? undefined : owner;
}

function staticPointcutExpression(annotationText: string): string | null {
  const args = parseSpringAnnotationArguments(annotationText);
  if (args === null) return null;
  const pointcutArguments = args.filter(
    (argument) =>
      argument.name === undefined || argument.name === 'value' || argument.name === 'pointcut',
  );
  if (pointcutArguments.length !== 1) return null;
  const allowedCompanionArguments = new Set(['returning', 'throwing', 'argNames']);
  if (
    args.some(
      (argument) =>
        argument !== pointcutArguments[0] &&
        (argument.name === undefined || !allowedCompanionArguments.has(argument.name)),
    )
  ) {
    return null;
  }
  const argument = pointcutArguments[0];
  if (argument === undefined) return null;
  const parsed = parseStaticStringLiteral(argument.value);
  return parsed === null ? null : sanitizePointcut(parsed);
}

function sanitizePointcut(value: string): string | null {
  const normalized = stripBidiAndZeroWidth(value).replace(/\s+/g, ' ').trim();
  return normalized.length > 0 && normalized.length <= MAX_POINTCUT_LENGTH ? normalized : null;
}

/**
 * Resolve syntax facts after imports and package visibility are complete.
 * Language adapters own AST shape only; this shared layer owns framework FQNs.
 */
export function createSpringAopMetadataAttacher<Annotation extends SpringAopAnnotationFact>(
  adapter: SpringAopMetadataAdapter<Annotation>,
) {
  return (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    indexes: ScopeResolutionIndexes,
  ): void => {
    const resolveAnnotation = createSpringAnnotationNameResolver(indexes);
    const metadata = graphMetadata(graph);

    for (const parsed of parsedFiles) {
      // The set is populated only by registered language adapters. The shared
      // matcher can therefore reject same-qualified-name symbols from other
      // languages without naming Java/Kotlin in framework-generic code.
      metadata.candidateFilePaths.add(parsed.filePath);
      const incomplete = adapter.isPackageVisibilityIncomplete(parsed.filePath);
      const resolvedAnnotations = new Map<string, string | undefined>();
      for (const fact of adapter.getFacts(parsed.filePath)) {
        const owner = ownerGraphNode(fact, indexes, nodeLookup, graph);
        const ownerScope = indexes.scopeTree.getScope(fact.ownerScopeId);
        if (owner === undefined || ownerScope === undefined) continue;
        if (fact.ownerKind === 'class' && fact.singletonInstance === true) {
          metadata.singletonInstanceClassIds.add(owner.id);
        }

        for (const annotation of fact.annotations) {
          // `@get:`, `@field:`, etc. target generated/property elements rather
          // than the callable represented by this fact. Guessing would overstate
          // proxy behavior, so Kotlin use-site targets fail closed.
          if (annotation.useSiteTarget !== undefined) continue;
          const cacheKey = `${ownerScope.parent ?? '<root>'}\0${annotation.name}`;
          let resolved = resolvedAnnotations.get(cacheKey);
          if (!resolvedAnnotations.has(cacheKey)) {
            resolved = resolveAnnotation(
              annotation.name,
              parsed,
              ownerScope.parent,
              RECOGNIZED_AOP_ANNOTATIONS,
              incomplete,
            );
            resolvedAnnotations.set(cacheKey, resolved);
          }
          if (resolved === undefined) continue;

          if (resolved === ASPECT_ANNOTATION && fact.ownerKind === 'class') {
            metadata.aspectClassIds.add(owner.id);
            metadata.aspects.push({
              ownerId: owner.id,
              annotation: resolved,
              line: annotation.line,
            });
            continue;
          }

          const behavior = BEHAVIOR_ANNOTATIONS.get(resolved);
          if (behavior !== undefined) {
            metadata.behaviors.push({
              ownerId: owner.id,
              ownerKind: fact.ownerKind,
              annotation: resolved,
              behavior,
              line: annotation.line,
            });
            continue;
          }

          const advice = ADVICE_ANNOTATIONS.get(resolved);
          if (advice !== undefined && fact.ownerKind === 'callable' && owner.label === 'Method') {
            metadata.advices.push({
              ownerId: owner.id,
              annotation: resolved,
              advice,
              pointcut: staticPointcutExpression(annotation.text),
              line: annotation.line,
            });
          }
        }
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = MAX_POINTCUT_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

const BEHAVIORS = new Set<SpringAopBehavior>([
  'transactional',
  'caching',
  'cacheable',
  'cache-evict',
  'cache-put',
  'authorization',
]);
const ADVICES = new Set<Exclude<SpringAopAdviceKind, 'pointcut'>>([
  'around',
  'before',
  'after',
  'after-returning',
  'after-throwing',
]);

export function encodeSpringAopReason(reason: SpringAopReason): string {
  return `${SPRING_AOP_REASON_PREFIX}${JSON.stringify(reason)}`;
}

/** Decode only the current, validated reason contract; malformed/foreign rows fail closed. */
export function decodeSpringAopReason(value: unknown): SpringAopReason | undefined {
  if (typeof value !== 'string' || !value.startsWith(SPRING_AOP_REASON_PREFIX)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(SPRING_AOP_REASON_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isBoundedString(parsed.annotation)) return undefined;

  if (
    parsed.kind === 'behavior' &&
    typeof parsed.behavior === 'string' &&
    BEHAVIORS.has(parsed.behavior as SpringAopBehavior) &&
    BEHAVIOR_ANNOTATIONS.get(parsed.annotation) === parsed.behavior &&
    (parsed.declaredOn === 'class' || parsed.declaredOn === 'method') &&
    parsed.activation === 'unknown' &&
    parsed.proxy === 'possible'
  ) {
    return parsed as unknown as SpringAopBehaviorReason;
  }
  if (
    parsed.kind === 'advice' &&
    typeof parsed.advice === 'string' &&
    ADVICES.has(parsed.advice as Exclude<SpringAopAdviceKind, 'pointcut'>) &&
    ADVICE_ANNOTATIONS.get(parsed.annotation) === parsed.advice &&
    isBoundedString(parsed.pointcut) &&
    parsed.match === 'static' &&
    parsed.activation === 'unknown' &&
    parsed.proxy === 'possible'
  ) {
    return parsed as unknown as SpringAopAdviceReason;
  }
  if (
    parsed.kind === 'pointcut' &&
    ADVICE_ANNOTATIONS.has(parsed.annotation) &&
    (parsed.pointcut === null || isBoundedString(parsed.pointcut)) &&
    ((parsed.match === 'static' &&
      parsed.resolution === 'resolved' &&
      typeof parsed.pointcut === 'string') ||
      (parsed.match === 'unresolved' && parsed.resolution === 'unknown'))
  ) {
    return parsed as unknown as SpringAopPointcutReason;
  }
  if (
    parsed.kind === 'aspect' &&
    parsed.annotation === ASPECT_ANNOTATION &&
    parsed.activation === 'unknown' &&
    parsed.registration === 'unknown'
  ) {
    return parsed as unknown as SpringAopAspectReason;
  }
  return undefined;
}

export function isSpringAopEvidenceNode(node: GraphNode): boolean {
  return node.label === 'CodeElement' && node.id.startsWith(SPRING_AOP_EVIDENCE_ID_PREFIX);
}

export function isSpringAopDeclaration(relationship: GraphRelationship): boolean {
  return (
    relationship.type === 'DECLARES' && relationship.reason.startsWith(SPRING_AOP_REASON_PREFIX)
  );
}

export interface SpringAopExecutionPointcut {
  readonly kind: 'execution';
  readonly ownerPattern: string;
  readonly methodPattern: string;
  readonly visibility?: 'public';
  readonly parameterCount?: number;
}

export interface SpringAopWithinPointcut {
  readonly kind: 'within';
  readonly ownerPattern: string;
}

export interface SpringAopAnnotationPointcut {
  readonly kind: 'annotation';
  readonly annotation: string;
}

export type SpringAopStaticPointcut =
  | SpringAopExecutionPointcut
  | SpringAopWithinPointcut
  | SpringAopAnnotationPointcut;

const TYPE_PATTERN = /^[A-Za-z_$*][A-Za-z0-9_$.*]*$/;
const METHOD_PATTERN = /^[A-Za-z_$*][A-Za-z0-9_$*]*$/;

/** Parse the deliberately narrow, fully static pointcut subset supported in v1. */
export function parseSpringAopPointcut(expression: string): SpringAopStaticPointcut | null {
  const normalized = sanitizePointcut(expression);
  if (normalized === null) return null;
  const annotation = /^@annotation\s*\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\)$/.exec(normalized);
  if (annotation !== null) {
    const annotationName = annotation[1];
    return annotationName !== undefined && BEHAVIOR_ANNOTATIONS.has(annotationName)
      ? { kind: 'annotation', annotation: annotationName }
      : null;
  }
  const within = /^within\s*\(\s*([^()]+?)\s*\)$/.exec(normalized);
  if (within !== null) {
    const ownerPattern = within[1]?.trim();
    return ownerPattern !== undefined && validTypePattern(ownerPattern)
      ? { kind: 'within', ownerPattern }
      : null;
  }

  const execution = /^execution\s*\(\s*([^()]*)\(([^()]*)\)\s*\)$/.exec(normalized);
  if (execution === null) return null;
  const head = execution[1]?.trim();
  const parameters = execution[2]?.trim();
  if (head === undefined || parameters === undefined) return null;
  const tokens = head.split(/\s+/);
  let visibility: 'public' | undefined;
  let returnPattern: string;
  let qualifiedMethod: string;
  if (tokens.length === 2) {
    [returnPattern, qualifiedMethod] = tokens as [string, string];
  } else if (tokens.length === 3 && tokens[0] === 'public') {
    const publicTokens = tokens as [string, string, string];
    visibility = 'public';
    returnPattern = publicTokens[1];
    qualifiedMethod = publicTokens[2];
  } else {
    return null;
  }
  if (returnPattern !== '*') return null;

  const separator = qualifiedMethod.lastIndexOf('.');
  const ownerPattern = separator === -1 ? '*' : qualifiedMethod.slice(0, separator);
  const methodPattern = separator === -1 ? qualifiedMethod : qualifiedMethod.slice(separator + 1);
  if (!validTypePattern(ownerPattern) || !METHOD_PATTERN.test(methodPattern)) return null;

  let parameterCount: number | undefined;
  if (parameters === '..') parameterCount = undefined;
  else if (parameters === '') parameterCount = 0;
  else {
    const parameterPatterns = parameters.split(',').map((part) => part.trim());
    if (parameterPatterns.some((part) => part !== '*')) return null;
    parameterCount = parameterPatterns.length;
  }

  return {
    kind: 'execution',
    ownerPattern,
    methodPattern,
    ...(visibility === undefined ? {} : { visibility }),
    ...(parameterCount === undefined ? {} : { parameterCount }),
  };
}

function validTypePattern(pattern: string): boolean {
  return (
    TYPE_PATTERN.test(pattern) &&
    // A simple exact type name needs the aspect's package/import scope to
    // resolve correctly. That context is not retained in the v1 record, so
    // fail closed instead of claiming a static match. Unqualified wildcard
    // patterns are self-contained and match the declaring type's simple name.
    (pattern.includes('.') || pattern.includes('*')) &&
    !pattern.includes('...') &&
    pattern.split('..').length <= 2 &&
    !pattern.endsWith('.')
  );
}

function findLiteral(
  value: string,
  literal: string,
  startIndex: number,
  endExclusive: number,
): number {
  const prefixLengths = new Array<number>(literal.length).fill(0);
  for (let index = 1, prefixLength = 0; index < literal.length; index += 1) {
    while (prefixLength > 0 && literal[index] !== literal[prefixLength]) {
      prefixLength = prefixLengths[prefixLength - 1] ?? 0;
    }
    if (literal[index] === literal[prefixLength]) prefixLength += 1;
    prefixLengths[index] = prefixLength;
  }

  for (let index = startIndex, prefixLength = 0; index < endExclusive; index += 1) {
    while (prefixLength > 0 && value[index] !== literal[prefixLength]) {
      prefixLength = prefixLengths[prefixLength - 1] ?? 0;
    }
    if (value[index] === literal[prefixLength]) prefixLength += 1;
    if (prefixLength === literal.length) return index - literal.length + 1;
  }
  return -1;
}

/** Match a single-segment glob in O(pattern + value) without regex backtracking. */
function segmentGlobMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const literalChunks = pattern.split('*').filter((chunk) => chunk.length > 0);
  if (literalChunks.length === 0) return true;

  let firstMiddleChunk = 0;
  let lastMiddleChunkExclusive = literalChunks.length;
  let cursor = 0;
  let middleEndExclusive = value.length;

  if (!pattern.startsWith('*')) {
    const prefix = literalChunks[0] ?? '';
    if (!value.startsWith(prefix)) return false;
    cursor = prefix.length;
    firstMiddleChunk = 1;
  }

  if (!pattern.endsWith('*')) {
    const suffix = literalChunks[literalChunks.length - 1] ?? '';
    const suffixStart = value.length - suffix.length;
    if (suffixStart < cursor || !value.endsWith(suffix)) return false;
    middleEndExclusive = suffixStart;
    lastMiddleChunkExclusive -= 1;
  }

  for (let index = firstMiddleChunk; index < lastMiddleChunkExclusive; index += 1) {
    const chunk = literalChunks[index] ?? '';
    const matchIndex = findLiteral(value, chunk, cursor, middleEndExclusive);
    if (matchIndex === -1) return false;
    cursor = matchIndex + chunk.length;
  }
  return cursor <= middleEndExclusive;
}

function patternSegmentsMatch(
  patternSegments: readonly string[],
  valueSegments: readonly string[],
) {
  return (
    patternSegments.length === valueSegments.length &&
    patternSegments.every((segment, index) =>
      segmentGlobMatches(segment, valueSegments[index] ?? ''),
    )
  );
}

/** Match Spring's narrow type-pattern subset without compiling repository input as regex. */
function typePatternMatches(pattern: string, value: string): boolean {
  if (!validTypePattern(pattern) || value.length === 0) return false;
  if (pattern === '*') return true;

  const valueSegments = value.split('.');
  if (valueSegments.some((segment) => segment.length === 0)) return false;
  if (!pattern.includes('.')) {
    return segmentGlobMatches(pattern, valueSegments[valueSegments.length - 1] ?? '');
  }
  const pieces = pattern.split('..');
  if (pieces.length === 1) return patternSegmentsMatch(pattern.split('.'), valueSegments);

  const leftSegments = (pieces[0] ?? '').split('.');
  const rightSegments = (pieces[1] ?? '').split('.');
  if (valueSegments.length < leftSegments.length + rightSegments.length) return false;
  return (
    patternSegmentsMatch(leftSegments, valueSegments.slice(0, leftSegments.length)) &&
    patternSegmentsMatch(rightSegments, valueSegments.slice(-rightSegments.length))
  );
}

export function springAopPointcutMatches(
  pointcut: SpringAopStaticPointcut,
  owner: GraphNode,
  method: GraphNode,
  methodAnnotations: ReadonlySet<string> = new Set(),
): boolean {
  if (method.label !== 'Method') return false;
  if (pointcut.kind === 'annotation') return methodAnnotations.has(pointcut.annotation);
  const qualifiedName = owner.properties.qualifiedName;
  if (typeof qualifiedName !== 'string') return false;
  if (!typePatternMatches(pointcut.ownerPattern, qualifiedName)) return false;
  if (pointcut.kind === 'within') return true;
  if (pointcut.visibility === 'public' && method.properties.visibility !== 'public') return false;
  if (
    pointcut.parameterCount !== undefined &&
    method.properties.parameterCount !== pointcut.parameterCount
  ) {
    return false;
  }
  return segmentGlobMatches(pointcut.methodPattern, method.properties.name);
}
