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
 * Interface resolution is scoped to the CANDIDATE'S OWN language and prefers
 * qualified names: a dotted element type resolves via the language's
 * `qualifiedName` index; a bare simple name resolves only while unique within
 * that language. Ambiguous names — simple OR qualified (a qualifiedName has
 * no file-path component, so the same package+name duplicated across monorepo
 * modules collides too) — fail CLOSED — no edge, never
 * last-writer-wins — but observably: skips are counted in the phase output's
 * `ambiguousSkipped` and named in an isDev debug log, so "no DI fields" is
 * distinguishable from "all candidates ambiguous". Same-package/import-aware
 * disambiguation is a documented follow-up (see the plan's Deferred work).
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
  /** Candidates skipped because their element type name — bare simple name
   *  or dotted qualified name — matched more than one Interface within the
   *  candidate's language (fail-closed). */
  ambiguousSkipped: number;
}

/** Sentinel marking an interface name (simple or qualified) claimed by more
 *  than one Interface node within a language — resolution must fail closed. */
const AMBIGUOUS: unique symbol = Symbol('ambiguous');

/** Per-language interface lookup: qualified names resolve exactly; bare
 *  simple names resolve only while unique within the language. Both indexes
 *  fail closed on their own duplicates. */
interface InterfaceIndex {
  /** `properties.qualifiedName` → Interface node id (when extracted — e.g.
   *  package-qualified for languages with a file-scope package declaration),
   *  or {@link AMBIGUOUS} once a second Interface claims the same qualified
   *  name in the same language — realistic in monorepos, where the same
   *  package+name is duplicated across modules or main/test source roots
   *  (a qualifiedName carries no file-path component). */
  byQualifiedName: Map<string, string | typeof AMBIGUOUS>;
  /** `properties.name` → Interface node id, or {@link AMBIGUOUS} once a
   *  second same-name Interface appears in the same language. */
  bySimpleName: Map<string, string | typeof AMBIGUOUS>;
}

/** A Property node a registered matcher accepted as a DI fan-out candidate. */
interface CandidateField {
  propertyId: string;
  /** The candidate's language — interface resolution (Pass 3) looks up ONLY
   *  this language's interface index. */
  language: SupportedLanguages;
  elementTypeName: string;
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
        elementTypeName: match.elementTypeName,
        reason: match.reason,
      });
    });

    if (candidates.length === 0) {
      return { injectsEdges: 0, fieldsScanned: 0, ambiguousSkipped: 0 };
    }

    // ── Pass 2: build single-pass reverse indexes ─────────────────────────

    // interfaceNodeId → Set<implementerClassId>  (reverse of IMPLEMENTS edge)
    // IMPLEMENTS edges go Class→Interface, so target is the interface.
    // Keyed by node id — globally unique — so this index needs no language
    // scoping; only NAME-based lookups (below) do.
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

    // language → InterfaceIndex  (from Interface-labeled nodes). Scoped per
    // language so an Interface in one language can never satisfy a candidate
    // from another. Within a language, a name resolves only while unique —
    // a second Interface claiming the same simple OR qualified name flips
    // that entry to AMBIGUOUS and resolution fails closed (never
    // last-writer-wins).
    // Index only languages that can resolve: an Interface in a language with
    // no candidate can never be looked up in Pass 3.
    const candidateLanguages = new Set<string>(candidates.map((c) => c.language));
    const interfacesByLanguage = new Map<string, InterfaceIndex>();
    ctx.graph.forEachNode((node) => {
      if (node.label !== 'Interface') return;
      const language = node.properties.language;
      if (typeof language !== 'string') return; // no language ⇒ unindexable
      if (!candidateLanguages.has(language)) return;
      let index = interfacesByLanguage.get(language);
      if (index === undefined) {
        index = { byQualifiedName: new Map(), bySimpleName: new Map() };
        interfacesByLanguage.set(language, index);
      }
      // `qualifiedName` reaches NodeProperties through the extensible index
      // signature, so narrow it explicitly (no `any`).
      const qualifiedName = node.properties.qualifiedName;
      if (typeof qualifiedName === 'string') {
        index.byQualifiedName.set(
          qualifiedName,
          index.byQualifiedName.has(qualifiedName) ? AMBIGUOUS : node.id,
        );
      }
      const simpleName = node.properties.name;
      index.bySimpleName.set(simpleName, index.bySimpleName.has(simpleName) ? AMBIGUOUS : node.id);
    });

    // ── Pass 3: emit INJECTS edges ────────────────────────────────────────
    let injectsEdges = 0;
    let ambiguousSkipped = 0;
    const ambiguousElementTypes = new Set<string>();
    const seenEdges = new Set<string>();

    for (const candidate of candidates) {
      // Resolve the consumer Class that owns this Property.
      const consumerClassId = propertyToClass.get(candidate.propertyId);
      if (!consumerClassId) continue;

      // Resolve the element type name via the CANDIDATE'S OWN language index
      // only — a same-named Interface in another language never participates.
      const index = interfacesByLanguage.get(candidate.language);
      if (index === undefined) continue;

      // A dotted element type is a qualified name (e.g. `com.a.Shape`) —
      // exact qualifiedName lookup, unaffected by simple-name ambiguity.
      // A bare name uses the simple-name index. BOTH lookups fail CLOSED
      // on their own ambiguity (a qualified name too can be claimed twice —
      // same package+name across monorepo modules): no edge (never
      // last-writer-wins), but counted and logged so the skip is
      // observable. Same-package/import-aware disambiguation is a
      // deliberate follow-up (plan: Deferred work).
      let interfaceId: string | undefined;
      if (candidate.elementTypeName.includes('.')) {
        const entry = index.byQualifiedName.get(candidate.elementTypeName);
        if (entry === AMBIGUOUS) {
          ambiguousSkipped++;
          ambiguousElementTypes.add(candidate.elementTypeName);
          continue;
        }
        interfaceId = entry;
      } else {
        const entry = index.bySimpleName.get(candidate.elementTypeName);
        if (entry === AMBIGUOUS) {
          ambiguousSkipped++;
          ambiguousElementTypes.add(candidate.elementTypeName);
          continue;
        }
        interfaceId = entry;
      }
      if (interfaceId === undefined) continue;

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

    if (isDev && ambiguousSkipped > 0) {
      // One aggregated debug line (not per-candidate spam): duplicate simple
      // names are NORMAL in large repos, but the skip must stay observable.
      logger.debug(
        `🧩 DI: ${ambiguousSkipped} candidate(s) skipped — ambiguous element interface name(s): ${[...ambiguousElementTypes].sort().join(', ')}`,
      );
    }
    if (isDev && (injectsEdges > 0 || ambiguousSkipped > 0)) {
      logger.info(
        `🧩 DI: ${injectsEdges} INJECTS edges from ${candidates.length} injection-annotated collection fields (${ambiguousSkipped} ambiguous skipped)`,
      );
    }

    return { injectsEdges, fieldsScanned: candidates.length, ambiguousSkipped };
  },
};
