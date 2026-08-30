import type { ParsedFile, Range, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { DiInjectionMatch } from '../../di-extractors/index.js';
import { SPRING_DI_INJECTION_SITES_PROPERTY } from '../../di-extractors/spring.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  resolveCallerGraphId,
  resolveDefGraphId,
} from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { isClassLike, lookupBindingsAt } from '../../scope-resolution/scope/walkers.js';

const COLLECTION_LOOKUP_METHODS = new Set(['getBeans', 'getBeansOfType']);
const SINGLE_LOOKUP_METHODS = new Set(['getBean']);

/**
 * Distinctive utility names plus conventional Spring context variable names.
 * Generic locals remain recall-oriented because repositories often omit the
 * third-party context type from the index; AST call/class-literal gates and
 * import-aware target resolution prevent the raw-text false-positive class.
 */
const KNOWN_RECEIVERS = new Set([
  'SpringContextUtil',
  'SpringContextHolder',
  'SpringBeanUtil',
  'ApplicationContextProvider',
  'BeanFactoryProvider',
  'ApplicationContext',
  'BeanFactory',
  'ListableBeanFactory',
  'applicationContext',
  'context',
  'ctx',
  'appContext',
  'beanFactory',
]);

export interface SpringDynamicLookupFact {
  readonly ownerScopeId: ScopeId;
  readonly ownerRange: Range;
  readonly receiverName: string;
  readonly methodName: string;
  readonly targetTypeName: string;
}

export function springDynamicLookupCardinality(
  receiverName: string,
  methodName: string,
): 'single' | 'collection' | null {
  const receiverSimpleName = receiverName.slice(receiverName.lastIndexOf('.') + 1);
  if (!KNOWN_RECEIVERS.has(receiverSimpleName)) return null;
  if (COLLECTION_LOOKUP_METHODS.has(methodName)) return 'collection';
  if (SINGLE_LOOKUP_METHODS.has(methodName)) return 'single';
  return null;
}

function visibleTypeDefinitions(
  fact: SpringDynamicLookupFact,
  indexes: ScopeResolutionIndexes,
): readonly SymbolDefinition[] {
  const simpleName = fact.targetTypeName.slice(fact.targetTypeName.lastIndexOf('.') + 1);
  let scopeId: ScopeId | null = fact.ownerScopeId;

  while (scopeId !== null) {
    const visible = lookupBindingsAt(scopeId, simpleName, indexes)
      .map(({ def }) => def)
      .filter((def) => isClassLike(def.type))
      .filter(
        (def) => !fact.targetTypeName.includes('.') || def.qualifiedName === fact.targetTypeName,
      );
    if (visible.length > 0) {
      const unique = new Map(visible.map((def) => [def.nodeId, def]));
      return [...unique.values()];
    }
    scopeId = indexes.scopeTree.getScope(scopeId)?.parent ?? null;
  }

  return [];
}

function resolveTargetTypeName(
  graph: KnowledgeGraph,
  fact: SpringDynamicLookupFact,
  callerLanguage: string | undefined,
  nodeLookup: GraphNodeLookup,
  indexes: ScopeResolutionIndexes,
): string | undefined {
  const graphIds = new Set<string>();
  for (const definition of visibleTypeDefinitions(fact, indexes)) {
    const graphId = resolveDefGraphId(definition.filePath, definition, nodeLookup);
    if (graphId === undefined) continue;
    const node = graph.getNode(graphId);
    if (
      (node?.label === 'Class' ||
        node?.label === 'Interface' ||
        node?.label === 'Record' ||
        node?.label === 'Enum') &&
      node.properties.language === callerLanguage
    ) {
      graphIds.add(graphId);
    }
  }
  if (graphIds.size !== 1) return undefined;

  const targetId = graphIds.values().next().value;
  if (targetId === undefined) return undefined;
  const target = graph.getNode(targetId);
  if (target === undefined) return undefined;
  const qualifiedName = target.properties.qualifiedName;
  return typeof qualifiedName === 'string' ? qualifiedName : target.properties.name;
}

export interface SpringDynamicLookupMetadataAdapter {
  getFacts(filePath: string): readonly SpringDynamicLookupFact[];
}

/**
 * Attach AST-captured programmatic Spring lookups to the framework-neutral DI
 * resolver. Java/Kotlin own syntax capture; this shared JVM/Spring seam owns
 * import-aware type binding and metadata attachment.
 */
export function createSpringDynamicLookupMetadataAttacher(
  adapter: SpringDynamicLookupMetadataAdapter,
) {
  return (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    indexes: ScopeResolutionIndexes,
  ): void => {
    for (const parsed of parsedFiles) {
      for (const fact of adapter.getFacts(parsed.filePath)) {
        const cardinality = springDynamicLookupCardinality(fact.receiverName, fact.methodName);
        if (cardinality === null) continue;

        const callerId = resolveCallerGraphId(fact.ownerScopeId, indexes, nodeLookup, {
          startLine: fact.ownerRange.startLine,
          startCol: fact.ownerRange.startCol,
        });
        if (callerId === undefined) continue;
        const caller = graph.getNode(callerId);
        if (
          caller === undefined ||
          (caller.label !== 'Function' &&
            caller.label !== 'Method' &&
            caller.label !== 'Constructor')
        ) {
          continue;
        }

        const targetTypeName = resolveTargetTypeName(
          graph,
          fact,
          caller.properties.language,
          nodeLookup,
          indexes,
        );
        if (targetTypeName === undefined) continue;

        const match: DiInjectionMatch = {
          targetTypeName,
          cardinality,
          edgeSource: 'site',
          reason: `Spring dynamic lookup: ${fact.receiverName}.${fact.methodName}(${fact.targetTypeName})`,
        };
        // Singular lookups intentionally use the shared DI selection policy:
        // a unique/@Primary candidate wins; unresolved multiplicity is an
        // explicit 0.5-confidence fan-out rather than a guessed runtime winner.
        const existing = caller.properties[SPRING_DI_INJECTION_SITES_PROPERTY];
        caller.properties[SPRING_DI_INJECTION_SITES_PROPERTY] = [
          ...(Array.isArray(existing) ? existing : []),
          match,
        ];
      }
    }
  };
}
