/**
 * Phase: di
 *
 * Framework-neutral dependency-injection resolution. Routes `Property` nodes
 * by `properties.language` to the per-language field matchers registered in
 * `di-extractors/` (`DI_MATCHERS` — same registry seam shape as
 * `SCOPE_RESOLVERS`), then fans each match out to `INJECTS` edges from the
 * consumer Class node to every Class implementing the matched element
 * interface.
 *
 * This file names NO language or framework: which fields count as
 * container-injected — and why — is entirely the registered matcher's
 * business (see `di-extractors/` for the matchers and their semantics,
 * including deliberate annotation exclusions). The matcher also supplies the
 * human-readable edge `reason`, so framework specifics stay in the payload,
 * never in this phase.
 *
 * The resolution uses ONLY graph data — Property nodes, `HAS_PROPERTY` edges,
 * `IMPLEMENTS` edges, and Interface nodes. No filesystem access is performed:
 * the structural information was already extracted by earlier parse /
 * structure phases.
 *
 * @deps    mro
 * @reads   graph (Property nodes, HAS_PROPERTY edges, IMPLEMENTS edges, Interface nodes)
 * @writes  graph (INJECTS edges)
 */

import type { SupportedLanguages } from 'gitnexus-shared';
import type { PipelinePhase, PipelineContext } from './types.js';
import { DI_MATCHERS, isSupportedLanguage } from '../di-extractors/index.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

export interface DIOutput {
  injectsEdges: number;
  fieldsScanned: number;
}

/** A Property node a registered matcher accepted as a DI fan-out candidate. */
interface CandidateField {
  propertyId: string;
  /** The candidate's language — kept for language-scoped interface
   *  resolution (U4). */
  language: SupportedLanguages;
  collectionType: string;
  elementTypeName: string;
  /** The injection annotation that gated this candidate (e.g. '@Autowired'). */
  matchedAnnotation: string;
  /** Matcher-supplied edge reason (carries the framework specifics). */
  reason: string;
}

export const diPhase: PipelinePhase<DIOutput> = {
  name: 'di',
  // Depends on `mro` for ordering: heritage edges (IMPLEMENTS/EXTENDS) must be
  // fully populated before we resolve interface→implementer fan-out.
  deps: ['mro'],

  async execute(ctx: PipelineContext): Promise<DIOutput> {
    ctx.onProgress({
      phase: 'enriching',
      percent: 98,
      message: 'Resolving dependency-injection edges...',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
    });

    // ── Pass 1: route Property nodes to registered per-language matchers ───
    // Early-exit optimization: if no registered matcher accepts any Property
    // node, skip all index construction. This makes the phase a no-op on
    // repos with no DI-matched fields (no IMPLEMENTS / HAS_PROPERTY scans).
    const candidates: CandidateField[] = [];

    ctx.graph.forEachNode((node) => {
      if (node.label !== 'Property') return;
      const language = node.properties.language;
      if (language === undefined || !isSupportedLanguage(language)) return;
      const matcher = DI_MATCHERS.get(language);
      if (matcher === undefined) return;
      const match = matcher(node);
      if (match === null) return;
      candidates.push({
        propertyId: node.id,
        language,
        collectionType: match.collectionType,
        elementTypeName: match.elementTypeName,
        matchedAnnotation: match.matchedAnnotation,
        reason: match.reason,
      });
    });

    if (candidates.length === 0) {
      return { injectsEdges: 0, fieldsScanned: 0 };
    }

    // ── Pass 2: build single-pass reverse indexes ─────────────────────────

    // interfaceNodeId → Set<implementerClassId>  (reverse of IMPLEMENTS edge)
    // IMPLEMENTS edges go Class→Interface, so target is the interface.
    const interfaceToImplementers = new Map<string, Set<string>>();
    for (const rel of ctx.graph.iterRelationshipsByType('IMPLEMENTS')) {
      const implementerId = rel.sourceId; // Class
      const interfaceId = rel.targetId; // Interface
      let set = interfaceToImplementers.get(interfaceId);
      if (set === undefined) {
        set = new Set();
        interfaceToImplementers.set(interfaceId, set);
      }
      set.add(implementerId);
    }

    // propertyNodeId → consumerClassId  (reverse of HAS_PROPERTY edge)
    // HAS_PROPERTY edges go Class→Property, so target is the property.
    const propertyToClass = new Map<string, string>();
    for (const rel of ctx.graph.iterRelationshipsByType('HAS_PROPERTY')) {
      propertyToClass.set(rel.targetId, rel.sourceId);
    }

    // interfaceName → interfaceNodeId  (from Interface-labeled nodes)
    const interfaceNameToId = new Map<string, string>();
    ctx.graph.forEachNode((node) => {
      if (node.label !== 'Interface') return;
      interfaceNameToId.set(node.properties.name, node.id);
    });

    // ── Pass 3: emit INJECTS edges ────────────────────────────────────────
    let injectsEdges = 0;
    const seenEdges = new Set<string>();

    for (const candidate of candidates) {
      // Resolve the consumer Class that owns this Property.
      const consumerClassId = propertyToClass.get(candidate.propertyId);
      if (!consumerClassId) continue;

      // Resolve the element type name to an Interface node by name.
      const interfaceId = interfaceNameToId.get(candidate.elementTypeName);
      if (!interfaceId) continue;

      // Fan out to every class implementing that interface.
      const implementers = interfaceToImplementers.get(interfaceId);
      if (!implementers) continue;

      for (const implId of implementers) {
        // Skip self-edges: a class never injects its own bean into itself.
        if (implId === consumerClassId) continue;

        // Dedup-safe edge ID: deterministic from (consumer, implementer).
        const edgeId = `INJECTS:${consumerClassId}->${implId}`;
        if (seenEdges.has(edgeId)) continue;
        seenEdges.add(edgeId);

        ctx.graph.addRelationship({
          id: edgeId,
          sourceId: consumerClassId,
          targetId: implId,
          type: 'INJECTS',
          confidence: 0.8,
          // Matcher-supplied reason — names the framework and the annotation
          // actually found on the field (see di-extractors/).
          reason: candidate.reason,
        });
        injectsEdges++;
      }
    }

    if (isDev && injectsEdges > 0) {
      logger.info(
        `🧩 DI: ${injectsEdges} INJECTS edges from ${candidates.length} injection-annotated collection fields`,
      );
    }

    return { injectsEdges, fieldsScanned: candidates.length };
  },
};
