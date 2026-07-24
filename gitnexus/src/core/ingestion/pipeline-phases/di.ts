/**
 * Phase: di
 *
 * Framework-neutral dependency-injection resolution. Per-language resolvers
 * identify injection sites and provider metadata; this phase performs only
 * graph-level type/heritage resolution and emits Class -> Class INJECTS edges.
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
    ctx.graph.forEachNode((node) => {
      const language = node.properties.language;
      if (language === undefined || !isSupportedLanguage(language)) return;
      const resolver = DI_RESOLVERS.get(language);
      if (resolver === undefined) return;

      const provider = resolver.matchProvider(node);
      if (provider !== null) providers.set(node.id, provider);
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

    const interfaceToImplementers = new Map<string, Set<string>>();
    for (const rel of ctx.graph.iterRelationshipsByType('IMPLEMENTS')) {
      const set = interfaceToImplementers.get(rel.targetId) ?? new Set<string>();
      set.add(rel.sourceId);
      interfaceToImplementers.set(rel.targetId, set);
    }

    const memberToClass = new Map<string, string>();
    for (const relationType of ['HAS_PROPERTY', 'HAS_METHOD'] as const) {
      for (const rel of ctx.graph.iterRelationshipsByType(relationType)) {
        memberToClass.set(rel.targetId, rel.sourceId);
      }
    }

    const candidateLanguages = new Set<string>(candidates.map((candidate) => candidate.language));
    const interfacesByLanguage = new Map<string, NameIndex>();
    const classesByLanguage = new Map<string, NameIndex>();
    const classNodes = new Map<string, GraphNode>();
    ctx.graph.forEachNode((node) => {
      if (node.label !== 'Class' && node.label !== 'Interface') return;
      const language = node.properties.language;
      if (typeof language !== 'string' || !candidateLanguages.has(language)) return;
      const indexes = node.label === 'Class' ? classesByLanguage : interfacesByLanguage;
      const index = indexes.get(language) ?? emptyNameIndex();
      addIndexedName(index, node);
      indexes.set(language, index);
      if (node.label === 'Class') classNodes.set(node.id, node);
    });

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

      const structural = new Set<string>();
      if (typeof classEntry === 'string') structural.add(classEntry);
      if (typeof interfaceEntry === 'string') {
        for (const id of interfaceToImplementers.get(interfaceEntry) ?? []) structural.add(id);
      }
      structural.delete(consumerClassId);
      if (structural.size === 0) continue;

      let viable = providerCandidates(structural, providers);
      const namedSelection = candidate.namedSelection;
      if (namedSelection !== undefined) {
        viable = viable.filter(
          (id) => providers.get(id)?.names.includes(namedSelection.name) === true,
        );
        if (viable.length === 0) continue;
      }

      if (candidate.cardinality === 'collection') {
        const confidence = namedSelection === undefined ? 0.8 : 0.9;
        const suffix = namedSelection === undefined ? '' : `; ${namedSelection.reason}`;
        for (const targetId of viable) {
          queueEdge({
            sourceId: consumerClassId,
            targetId,
            confidence,
            reason: candidate.reason + suffix,
          });
        }
        continue;
      }

      if (viable.length === 1) {
        const suffix = namedSelection === undefined ? '' : `; ${namedSelection.reason}`;
        queueEdge({
          sourceId: consumerClassId,
          targetId: viable[0],
          confidence: namedSelection === undefined ? 0.9 : 0.95,
          reason: candidate.reason + suffix,
        });
        continue;
      }

      const preferred = viable.flatMap((id) => {
        const reason = providers.get(id)?.preferenceReason;
        return reason === undefined ? [] : [{ id, reason }];
      });
      if (namedSelection === undefined && preferred.length === 1) {
        const selected = preferred[0];
        queueEdge({
          sourceId: consumerClassId,
          targetId: selected.id,
          confidence: 0.95,
          reason: `${candidate.reason}; ${selected.reason}`,
        });
        continue;
      }

      ambiguousInjections++;
      const candidateNames = viable
        .map((id) => classNodes.get(id)?.properties.name ?? id)
        .sort()
        .join(', ');
      for (const targetId of viable) {
        queueEdge({
          sourceId: consumerClassId,
          targetId,
          confidence: 0.5,
          reason: `${candidate.reason}; ambiguous candidates: ${candidateNames}`,
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
