import type { GraphNode, ParsedFile, Range, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveCallerGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { createSpringAnnotationNameResolver } from './bean-candidates.js';

export const SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER = 3.0;

export type SpringNonHttpHandlerKind = 'scheduled' | 'event' | 'message' | 'xxl-job';

export interface SpringNonHttpHandlerAnnotationFact {
  readonly name: string;
  /** Kotlin use-site targets describe generated/property elements, not the callable. */
  readonly useSiteTarget?: string;
}

export interface SpringNonHttpHandlerFact<
  Annotation extends SpringNonHttpHandlerAnnotationFact = SpringNonHttpHandlerAnnotationFact,
> {
  readonly ownerScopeId: ScopeId;
  readonly ownerFilePath?: string;
  /** Exact syntax range used only as a fail-closed bridge for collapsed language scopes. */
  readonly ownerRange?: Range;
  readonly annotations: readonly Annotation[];
}

export interface SpringNonHttpHandlerAdapter<
  Annotation extends SpringNonHttpHandlerAnnotationFact,
> {
  getFacts(filePath: string): readonly SpringNonHttpHandlerFact<Annotation>[];
  isPackageVisibilityIncomplete(filePath: string): boolean;
}

const HANDLER_ANNOTATIONS = new Map<string, SpringNonHttpHandlerKind>([
  ['org.springframework.scheduling.annotation.Scheduled', 'scheduled'],
  ['org.springframework.scheduling.annotation.Schedules', 'scheduled'],
  ['org.springframework.context.event.EventListener', 'event'],
  ['org.springframework.transaction.event.TransactionalEventListener', 'event'],
  ['org.springframework.modulith.events.ApplicationModuleListener', 'event'],
  ['org.springframework.kafka.annotation.KafkaListener', 'message'],
  ['org.springframework.kafka.annotation.KafkaListeners', 'message'],
  ['org.springframework.amqp.rabbit.annotation.RabbitListener', 'message'],
  ['org.springframework.amqp.rabbit.annotation.RabbitListeners', 'message'],
  ['org.springframework.jms.annotation.JmsListener', 'message'],
  ['org.springframework.jms.annotation.JmsListeners', 'message'],
  ['org.springframework.pulsar.annotation.PulsarListener', 'message'],
  ['org.springframework.pulsar.annotation.PulsarListeners', 'message'],
  ['io.awspring.cloud.sqs.annotation.SqsListener', 'message'],
  ['io.awspring.cloud.messaging.listener.annotation.SqsListener', 'message'],
  ['org.springframework.cloud.aws.messaging.listener.annotation.SqsListener', 'message'],
  ['org.springframework.cloud.stream.annotation.StreamListener', 'message'],
  ['org.springframework.integration.annotation.ServiceActivator', 'message'],
  ['org.springframework.messaging.handler.annotation.MessageMapping', 'message'],
  ['org.springframework.messaging.simp.annotation.SubscribeMapping', 'message'],
  ['com.xxl.job.core.handler.annotation.XxlJob', 'xxl-job'],
]);

const RECOGNIZED_HANDLER_ANNOTATIONS = new Set(HANDLER_ANNOTATIONS.keys());

function simpleName(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator === -1 ? name : name.slice(separator + 1);
}

const CAPTURE_RELEVANT_SIMPLE_NAMES = new Set([...RECOGNIZED_HANDLER_ANNOTATIONS].map(simpleName));

export function hasSpringNonHttpHandlerRelevantAnnotation(
  annotations: readonly Pick<SpringNonHttpHandlerAnnotationFact, 'name'>[],
): boolean {
  return annotations.some((annotation) =>
    CAPTURE_RELEVANT_SIMPLE_NAMES.has(simpleName(annotation.name)),
  );
}

function exactCallableOwnersByRange(graph: KnowledgeGraph): ReadonlyMap<string, GraphNode | null> {
  const owners = new Map<string, GraphNode | null>();
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Method' || typeof node.properties.filePath !== 'string') continue;
    const key = `${node.properties.filePath}\0${node.properties.startLine}\0${node.properties.endLine}`;
    owners.set(key, owners.has(key) ? null : node);
  }
  return owners;
}

function ownerGraphNode(
  fact: SpringNonHttpHandlerFact,
  indexes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
  graph: KnowledgeGraph,
  exactOwnerByRange: ReadonlyMap<string, GraphNode | null>,
): GraphNode | undefined {
  let ownerId = resolveCallerGraphId(fact.ownerScopeId, indexes, nodeLookup);
  if (ownerId === undefined && fact.ownerFilePath !== undefined && fact.ownerRange !== undefined) {
    const fallback = exactOwnerByRange.get(
      `${fact.ownerFilePath}\0${fact.ownerRange.startLine - 1}\0${fact.ownerRange.endLine - 1}`,
    );
    if (fallback !== null && fallback !== undefined) ownerId = fallback.id;
  }
  if (ownerId === undefined) return undefined;
  const owner = graph.getNode(ownerId);
  return owner?.label === 'Method' ? owner : undefined;
}

function handlerReason(kinds: ReadonlySet<SpringNonHttpHandlerKind>): string {
  if (kinds.size !== 1) {
    return kinds.has('xxl-job') ? 'managed-non-http-handler' : 'spring-non-http-handler';
  }
  const kind = kinds.values().next().value;
  if (kind === 'xxl-job') return 'xxl-job-handler';
  return `spring-${kind}-handler`;
}

/**
 * Resolve callable annotations after imports and package visibility finalize,
 * then promote confirmed framework-managed handlers into process entry points.
 */
export function createSpringNonHttpHandlerMetadataAttacher<
  Annotation extends SpringNonHttpHandlerAnnotationFact,
>(adapter: SpringNonHttpHandlerAdapter<Annotation>) {
  return (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    indexes: ScopeResolutionIndexes,
  ): void => {
    const resolveAnnotation = createSpringAnnotationNameResolver(indexes);
    const exactOwnerByRange = exactCallableOwnersByRange(graph);
    const classByMethod = new Map<string, GraphNode>();
    for (const relationship of graph.iterRelationshipsByType('HAS_METHOD')) {
      const owner = graph.getNode(relationship.sourceId);
      if (owner !== undefined) classByMethod.set(relationship.targetId, owner);
    }

    for (const parsed of parsedFiles) {
      const incomplete = adapter.isPackageVisibilityIncomplete(parsed.filePath);
      const resolvedAnnotations = new Map<string, string | undefined>();
      for (const fact of adapter.getFacts(parsed.filePath)) {
        const owner = ownerGraphNode(fact, indexes, nodeLookup, graph, exactOwnerByRange);
        if (owner === undefined || classByMethod.get(owner.id)?.label === 'Interface') continue;

        const ownerScope = indexes.scopeTree.getScope(fact.ownerScopeId);
        const kinds = new Set<SpringNonHttpHandlerKind>();
        for (const annotation of fact.annotations) {
          if (annotation.useSiteTarget !== undefined) continue;
          const enclosingScope = ownerScope?.parent ?? null;
          const cacheKey = `${enclosingScope ?? '<root>'}\0${annotation.name}`;
          let resolved = resolvedAnnotations.get(cacheKey);
          if (!resolvedAnnotations.has(cacheKey)) {
            resolved = resolveAnnotation(
              annotation.name,
              parsed,
              enclosingScope,
              RECOGNIZED_HANDLER_ANNOTATIONS,
              incomplete,
            );
            resolvedAnnotations.set(cacheKey, resolved);
          }
          if (resolved === undefined) continue;
          const kind = HANDLER_ANNOTATIONS.get(resolved);
          if (kind !== undefined) kinds.add(kind);
        }
        if (kinds.size === 0) continue;

        const currentMultiplier = owner.properties.astFrameworkMultiplier ?? 1.0;
        owner.properties.astFrameworkMultiplier = Math.max(
          currentMultiplier,
          SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER,
        );
        if (
          currentMultiplier < SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER ||
          (currentMultiplier === SPRING_NON_HTTP_HANDLER_ENTRY_POINT_MULTIPLIER &&
            owner.properties.astFrameworkReason === undefined)
        ) {
          owner.properties.astFrameworkReason = handlerReason(kinds);
        }
      }
    }
  };
}
