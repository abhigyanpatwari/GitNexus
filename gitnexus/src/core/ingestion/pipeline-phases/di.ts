/**
 * Phase: di
 *
 * Framework-neutral dependency-injection resolution. Per-language resolvers
 * identify injection sites and provider metadata; this phase performs only
 * graph-level type/heritage resolution and emits owner/site -> provider INJECTS edges.
 *
 * @deps    mro
 * @reads   graph (Class/Interface/member nodes and heritage/ownership edges)
 * @writes  graph (INJECTS edges)
 */

import type { GraphNode, SupportedLanguages } from 'gitnexus-shared';
import type { PipelinePhase, PipelineContext } from './types.js';
import {
  DI_RESOLVERS,
  isSupportedLanguage,
  type DiInjectionMatch,
  type DiProviderMatch,
} from '../di-extractors/index.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

export interface DIOutput {
  injectsEdges: number;
  /** Kept for output compatibility; now counts every matched injection site. */
  fieldsScanned: number;
  /** Sites skipped because the requested type name itself was ambiguous. */
  ambiguousSkipped: number;
  /** Single-valued sites represented by multiple low-confidence candidates. */
  ambiguousInjections: number;
}

const AMBIGUOUS: unique symbol = Symbol('ambiguous');

interface NameIndex {
  byQualifiedName: Map<string, string | typeof AMBIGUOUS>;
  bySimpleName: Map<string, string | typeof AMBIGUOUS>;
}

interface CandidateSite extends DiInjectionMatch {
  siteNodeId: string;
  language: SupportedLanguages;
}

interface PendingEdge {
  sourceId: string;
  targetId: string;
  confidence: number;
  reason: string;
}

type ProvidedTypesByLanguage = Map<string, Map<string, Set<string>>>;

function addProvidedType(
  index: ProvidedTypesByLanguage,
  language: string,
  typeName: string,
  providerId: string,
): void {
  const byName = index.get(language) ?? new Map<string, Set<string>>();
  const names = new Set([typeName, typeName.slice(typeName.lastIndexOf('.') + 1)]);
  for (const name of names) {
    const providers = byName.get(name) ?? new Set<string>();
    providers.add(providerId);
    byName.set(name, providers);
  }
  index.set(language, byName);
}

function emptyNameIndex(): NameIndex {
  return { byQualifiedName: new Map(), bySimpleName: new Map() };
}

function addIndexedName(index: NameIndex, node: GraphNode): void {
  const qualifiedName = node.properties.qualifiedName;
  if (typeof qualifiedName === 'string') {
    index.byQualifiedName.set(
      qualifiedName,
      index.byQualifiedName.has(qualifiedName) ? AMBIGUOUS : node.id,
    );
  }
  const simpleName = node.properties.name;
  index.bySimpleName.set(simpleName, index.bySimpleName.has(simpleName) ? AMBIGUOUS : node.id);
}

function resolveIndexedName(index: NameIndex | undefined, name: string) {
  if (index === undefined) return undefined;
  return name.includes('.') ? index.byQualifiedName.get(name) : index.bySimpleName.get(name);
}

function providerCandidates(
  ids: ReadonlySet<string>,
  providers: ReadonlyMap<string, DiProviderMatch>,
): string[] {
  const all = [...ids];
  const recognized = all.filter((id) => providers.has(id));
  // Recall-first fallback: provider metadata can be incomplete (custom
  // registration mechanisms and legacy indexes can omit it). Prefer
  // framework-recognized providers when present, but keep structurally valid
  // candidates when none are known instead of dropping the injection entirely.
  return recognized.length > 0 ? recognized : all;
}

function isConcreteTypeNode(node: GraphNode | undefined): boolean {
  return node?.label === 'Class' || node?.label === 'Record' || node?.label === 'Enum';
}

export const diPhase: PipelinePhase<DIOutput> = {
  name: 'di',
  deps: ['mro'],

  async execute(ctx: PipelineContext): Promise<DIOutput> {
    ctx.onProgress({
      phase: 'enriching',
      percent: 98,
      message: 'Resolving dependency-injection edges...',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
    });

    const candidates: CandidateSite[] = [];
    const providers = new Map<string, DiProviderMatch>();
    const providedTypes = new Map<string, Map<string, Set<string>>>();
    const providerNames = new Map<string, Map<string, Set<string>>>();
    const providerNodes = new Map<string, GraphNode>();
    const providersByDeclarer = new Map<string, Set<string>>();
    ctx.graph.forEachNode((node) => {
      const language = node.properties.language;
      if (language === undefined || !isSupportedLanguage(language)) return;
      const resolver = DI_RESOLVERS.get(language);
      if (resolver === undefined) return;

      const provider = resolver.matchProvider(node);
      if (provider !== null) {
        providers.set(node.id, provider);
        providerNodes.set(node.id, node);
        const namesByLanguage = providerNames.get(language) ?? new Map<string, Set<string>>();
        for (const name of provider.names) {
          const namedProviders = namesByLanguage.get(name) ?? new Set<string>();
          namedProviders.add(node.id);
          namesByLanguage.set(name, namedProviders);
        }
        providerNames.set(language, namesByLanguage);
        if (provider.providedTypeName !== undefined) {
          addProvidedType(providedTypes, language, provider.providedTypeName, node.id);
        }
        if (provider.declaredByNodeId !== undefined) {
          const declared = providersByDeclarer.get(provider.declaredByNodeId) ?? new Set<string>();
          declared.add(node.id);
          providersByDeclarer.set(provider.declaredByNodeId, declared);
        }
      }
      for (const match of resolver.matchInjectionSites(node)) {
        candidates.push({ ...match, siteNodeId: node.id, language });
      }
    });

    if (candidates.length === 0) {
      return {
        injectsEdges: 0,
        fieldsScanned: 0,
        ambiguousSkipped: 0,
        ambiguousInjections: 0,
      };
    }

    const directSubtypes = new Map<string, Set<string>>();
    const directSupertypes = new Map<string, Set<string>>();
    for (const rel of ctx.graph.iterRelationshipsByType('IMPLEMENTS')) {
      const subtypes = directSubtypes.get(rel.targetId) ?? new Set<string>();
      subtypes.add(rel.sourceId);
      directSubtypes.set(rel.targetId, subtypes);
      const supertypes = directSupertypes.get(rel.sourceId) ?? new Set<string>();
      supertypes.add(rel.targetId);
      directSupertypes.set(rel.sourceId, supertypes);
    }
    for (const rel of ctx.graph.iterRelationshipsByType('EXTENDS')) {
      const subtypes = directSubtypes.get(rel.targetId) ?? new Set<string>();
      subtypes.add(rel.sourceId);
      directSubtypes.set(rel.targetId, subtypes);
      const supertypes = directSupertypes.get(rel.sourceId) ?? new Set<string>();
      supertypes.add(rel.targetId);
      directSupertypes.set(rel.sourceId, supertypes);
    }
    const orderedDirectSubtypes = new Map<string, readonly string[]>(
      [...directSubtypes].map(([typeId, subtypes]) => [typeId, [...subtypes].sort().reverse()]),
    );

    const memberToClass = new Map<string, string>();
    for (const relationType of ['HAS_PROPERTY', 'HAS_METHOD'] as const) {
      for (const rel of ctx.graph.iterRelationshipsByType(relationType)) {
        memberToClass.set(rel.targetId, rel.sourceId);
      }
    }

    const candidateLanguages = new Set<string>(candidates.map((candidate) => candidate.language));
    const interfacesByLanguage = new Map<string, NameIndex>();
    const classesByLanguage = new Map<string, NameIndex>();
    ctx.graph.forEachNode((node) => {
      const concreteType = isConcreteTypeNode(node);
      if (!concreteType && node.label !== 'Interface') return;
      const language = node.properties.language;
      if (typeof language !== 'string' || !candidateLanguages.has(language)) return;
      const indexes = concreteType ? classesByLanguage : interfacesByLanguage;
      const index = indexes.get(language) ?? emptyNameIndex();
      addIndexedName(index, node);
      indexes.set(language, index);
      if (concreteType) providerNodes.set(node.id, node);
    });

    const concreteSubtypesByRoot = new Map<string, ReadonlySet<string>>();
    const concreteSubtypes = (rootTypeId: string, language: string): ReadonlySet<string> => {
      const cacheKey = `${language}\0${rootTypeId}`;
      const cached = concreteSubtypesByRoot.get(cacheKey);
      if (cached !== undefined) return cached;

      const concrete = new Set<string>();
      const queue = [rootTypeId];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const typeId = queue.pop();
        if (typeId === undefined || visited.has(typeId)) continue;
        visited.add(typeId);
        const typeNode = ctx.graph.getNode(typeId);
        if (
          typeNode !== undefined &&
          isConcreteTypeNode(typeNode) &&
          typeNode.properties.language === language
        ) {
          concrete.add(typeId);
        }
        const children = orderedDirectSubtypes.get(typeId) ?? [];
        queue.push(...children);
      }
      concreteSubtypesByRoot.set(cacheKey, concrete);
      return concrete;
    };

    // A declaration returning a concrete class is assignable to every class or
    // interface that type extends/implements. Expand once per language+type and
    // register the declaration under those ancestor names. This keeps named
    // selection fast (set intersection below) while allowing, for example, a
    // `DefaultGateway` Bean to satisfy a named `Gateway` Resource site.
    const assignableNamesByProvidedType = new Map<string, readonly string[]>();
    for (const [providerId, provider] of providers) {
      if (provider.providedTypeName === undefined) continue;
      const providerNode = providerNodes.get(providerId);
      const language = providerNode?.properties.language;
      if (typeof language !== 'string') continue;
      const cacheKey = `${language}\0${provider.providedTypeName}`;
      let assignableTypeNames = assignableNamesByProvidedType.get(cacheKey);
      if (assignableTypeNames === undefined) {
        const classEntry = resolveIndexedName(
          classesByLanguage.get(language),
          provider.providedTypeName,
        );
        const interfaceEntry = resolveIndexedName(
          interfacesByLanguage.get(language),
          provider.providedTypeName,
        );
        const rootTypeId =
          typeof classEntry === 'string' && interfaceEntry === undefined
            ? classEntry
            : typeof interfaceEntry === 'string' && classEntry === undefined
              ? interfaceEntry
              : undefined;
        const names = new Set<string>();
        if (rootTypeId !== undefined) {
          const queue = [rootTypeId];
          const visited = new Set<string>();
          while (queue.length > 0) {
            const typeId = queue.pop();
            if (typeId === undefined) continue;
            if (visited.has(typeId)) continue;
            visited.add(typeId);
            const typeNode = ctx.graph.getNode(typeId);
            if (
              (typeNode?.label === 'Class' || typeNode?.label === 'Interface') &&
              typeNode.properties.language === language
            ) {
              names.add(typeNode.properties.name);
              const qualifiedName = typeNode.properties.qualifiedName;
              if (typeof qualifiedName === 'string') names.add(qualifiedName);
            }
            for (const supertypeId of directSupertypes.get(typeId) ?? []) {
              queue.push(supertypeId);
            }
          }
        }
        assignableTypeNames = [...names];
        assignableNamesByProvidedType.set(cacheKey, assignableTypeNames);
      }
      for (const typeName of assignableTypeNames) {
        addProvidedType(providedTypes, language, typeName, providerId);
      }
    }

    let ambiguousSkipped = 0;
    let ambiguousInjections = 0;
    const ambiguousTypeNames = new Set<string>();
    const pending = new Map<string, PendingEdge>();

    const queueEdge = (edge: PendingEdge): void => {
      if (edge.sourceId === edge.targetId) return;
      const id = `INJECTS:${edge.sourceId}->${edge.targetId}`;
      const existing = pending.get(id);
      if (existing === undefined || edge.confidence > existing.confidence) pending.set(id, edge);
    };

    for (const candidate of candidates) {
      const siteNode = ctx.graph.getNode(candidate.siteNodeId);
      const consumerClassId =
        siteNode?.label === 'Class' ? siteNode.id : memberToClass.get(candidate.siteNodeId);
      if (consumerClassId === undefined) continue;
      const edgeSourceId =
        candidate.edgeSource === 'site' && siteNode !== undefined ? siteNode.id : consumerClassId;

      const classEntry = resolveIndexedName(
        classesByLanguage.get(candidate.language),
        candidate.targetTypeName,
      );
      const interfaceEntry = resolveIndexedName(
        interfacesByLanguage.get(candidate.language),
        candidate.targetTypeName,
      );
      if (
        classEntry === AMBIGUOUS ||
        interfaceEntry === AMBIGUOUS ||
        (classEntry !== undefined && interfaceEntry !== undefined)
      ) {
        // A simple/qualified name claimed by both a Class and an Interface is
        // type-ambiguous too. Fail closed rather than guessing which Java type
        // the injection site meant; import-aware disambiguation is not
        // available in this graph-only phase. This intentionally applies to
        // legacy collection sites too: a Class/Interface collision no longer
        // fans out through the interface on a simple-name guess.
        ambiguousSkipped++;
        ambiguousTypeNames.add(candidate.targetTypeName);
        continue;
      }

      const rootTypeId =
        typeof classEntry === 'string'
          ? classEntry
          : typeof interfaceEntry === 'string'
            ? interfaceEntry
            : undefined;
      const structural = new Set(
        rootTypeId === undefined ? [] : concreteSubtypes(rootTypeId, candidate.language),
      );
      for (const id of providedTypes.get(candidate.language)?.get(candidate.targetTypeName) ?? []) {
        structural.add(id);
      }
      for (const id of providersByDeclarer.get(edgeSourceId) ?? []) structural.delete(id);
      structural.delete(consumerClassId);
      structural.delete(edgeSourceId);
      if (structural.size === 0) continue;

      const namedSelection = candidate.namedSelection;
      let usedNamedSelection = false;
      let selectionSuffix = '';
      let viable: string[];
      if (namedSelection !== undefined) {
        const named = [
          ...(providerNames.get(candidate.language)?.get(namedSelection.name) ?? []),
        ].filter((id) => structural.has(id));
        if (named.length > 0) {
          viable = named;
          usedNamedSelection = true;
          selectionSuffix = `; ${namedSelection.reason}`;
        } else if (namedSelection.fallbackToType === true) {
          viable = providerCandidates(structural, providers);
          selectionSuffix = `; ${namedSelection.reason} unmatched; type fallback`;
        } else {
          continue;
        }
      } else {
        viable = providerCandidates(structural, providers);
      }

      if (candidate.cardinality === 'collection') {
        const confidence = usedNamedSelection ? 0.9 : 0.8;
        for (const targetId of viable) {
          queueEdge({
            sourceId: edgeSourceId,
            targetId,
            confidence,
            reason: candidate.reason + selectionSuffix,
          });
        }
        continue;
      }

      if (viable.length === 1) {
        queueEdge({
          sourceId: edgeSourceId,
          targetId: viable[0],
          confidence: usedNamedSelection ? 0.95 : namedSelection === undefined ? 0.9 : 0.85,
          reason: candidate.reason + selectionSuffix,
        });
        continue;
      }

      const preferred = viable.flatMap((id) => {
        const reason = providers.get(id)?.preferenceReason;
        return reason === undefined ? [] : [{ id, reason }];
      });
      if (!usedNamedSelection && preferred.length === 1) {
        const selected = preferred[0];
        queueEdge({
          sourceId: edgeSourceId,
          targetId: selected.id,
          confidence: 0.95,
          reason: `${candidate.reason}${selectionSuffix}; ${selected.reason}`,
        });
        continue;
      }

      ambiguousInjections++;
      const candidateNames = viable
        .map((id) => providerNodes.get(id)?.properties.name ?? id)
        .sort()
        .join(', ');
      for (const targetId of viable) {
        queueEdge({
          sourceId: edgeSourceId,
          targetId,
          confidence: 0.5,
          reason: `${candidate.reason}${selectionSuffix}; ambiguous candidates: ${candidateNames}`,
        });
      }
    }

    for (const [id, edge] of pending) {
      ctx.graph.addRelationship({ id, type: 'INJECTS', ...edge });
    }

    if (isDev && ambiguousSkipped > 0) {
      logger.debug(
        `DI: ${ambiguousSkipped} site(s) skipped because requested type names were ambiguous: ${[...ambiguousTypeNames].sort().join(', ')}`,
      );
    }
    if (isDev && (pending.size > 0 || ambiguousInjections > 0)) {
      logger.info(
        `DI: ${pending.size} INJECTS edges from ${candidates.length} injection sites (${ambiguousInjections} ambiguous single-site resolutions)`,
      );
    }

    return {
      injectsEdges: pending.size,
      fieldsScanned: candidates.length,
      ambiguousSkipped,
      ambiguousInjections,
    };
  },
};
