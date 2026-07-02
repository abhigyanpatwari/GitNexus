/**
 * Phase: spring-di
 *
 * Resolves Spring dependency-injection collection fields. When a Java class
 * declares a field carrying an injection annotation (`@Autowired` or
 * `@Inject`) typed as `List<T>`, `Set<T>`, `Collection<T>`, or `Map<K,T>`,
 * the Spring container injects EVERY bean implementing interface `T`. This
 * phase materializes that semantic relationship as `INJECTS` edges from the
 * consumer Class node to each implementing Class node.
 *
 * The injection annotation is a hard precondition: a plain (non-annotated)
 * collection field is never injected by the container and produces no edges.
 * `@Resource` (JSR-250) is DELIBERATELY excluded: it resolves by bean NAME
 * first (defaulting to the field name), which injects a single named
 * collection bean — the opposite of the collect-all-implementers fan-out
 * INJECTS models. Including it would emit false edges.
 *
 * The resolution uses ONLY graph data — Property nodes (with
 * `rawDeclaredType` + `annotations` + `language`), `HAS_PROPERTY` edges,
 * `IMPLEMENTS` edges, and Interface nodes. Matching happens on
 * `rawDeclaredType` (the verbatim type text, generics preserved) — NOT
 * `declaredType`, which is generics-stripped by design (`List<Shape>` →
 * `List`) and can never match the collection patterns. No filesystem access
 * is performed: the structural information was already extracted by earlier
 * parse / structure phases.
 *
 * @deps    mro
 * @reads   graph (Property nodes, HAS_PROPERTY edges, IMPLEMENTS edges, Interface nodes)
 * @writes  graph (INJECTS edges)
 */

import type { PipelinePhase, PipelineContext } from './types.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

export interface SpringDIOutput {
  injectsEdges: number;
  fieldsScanned: number;
}

/**
 * Annotations that trigger Spring's collect-all-implementers collection
 * injection. `@Resource` is deliberately absent — JSR-250 resolves by bean
 * NAME first (defaulting to the field name), injecting a single named
 * collection bean rather than fanning out to every implementer, so an
 * INJECTS fan-out for it would be a false edge.
 */
const INJECTION_ANNOTATIONS: ReadonlySet<string> = new Set(['@Autowired', '@Inject']);

/** Matches `List<T>`, `Set<T>`, `Collection<T>` — captures the collection
 *  wrapper and the single element type. */
const COLLECTION_TYPE_PATTERN = /^(List|Set|Collection)<(.+)>$/;
/** Matches `Map<K,T>` — captures only the value type `T` (the injected bean
 *  type); the key type `K` is irrelevant for DI resolution. */
const MAP_TYPE_PATTERN = /^Map<[^,]+,\s*(.+)>$/;

/**
 * Parse a Spring DI collection field's raw declared type (verbatim source
 * text, generics preserved) and return the injected bean type name.
 *
 * @returns the collection wrapper name + element type name, or `null` when
 *          the raw declared type is not a recognized Spring collection shape.
 */
function parseSpringCollectionType(
  rawDeclaredType: string,
): { collectionType: string; elementTypeName: string } | null {
  const listMatch = COLLECTION_TYPE_PATTERN.exec(rawDeclaredType);
  if (listMatch) {
    return { collectionType: listMatch[1], elementTypeName: listMatch[2] };
  }
  const mapMatch = MAP_TYPE_PATTERN.exec(rawDeclaredType);
  if (mapMatch) {
    return { collectionType: 'Map', elementTypeName: mapMatch[1] };
  }
  return null;
}

/** A Java Property node carrying an injection annotation whose declared
 *  type is a Spring DI collection. */
interface CandidateField {
  propertyId: string;
  collectionType: string;
  elementTypeName: string;
  /** The injection annotation that gated this candidate (e.g. '@Autowired'). */
  matchedAnnotation: string;
}

export const springDiPhase: PipelinePhase<SpringDIOutput> = {
  name: 'spring-di',
  // Depends on `mro` for ordering: heritage edges (IMPLEMENTS/EXTENDS) must be
  // fully populated before we resolve interface→implementer fan-out.
  deps: ['mro'],

  async execute(ctx: PipelineContext): Promise<SpringDIOutput> {
    ctx.onProgress({
      phase: 'enriching',
      percent: 98,
      message: 'Resolving Spring DI collection injections...',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
    });

    // ── Pass 1: collect matching Java collection-typed Property nodes ──────
    // Early-exit optimization: if the repo has zero Java Property nodes with a
    // Spring collection declared type, skip all index construction. This makes
    // the phase a no-op on non-Java repos (no IMPLEMENTS / HAS_PROPERTY scans).
    const candidates: CandidateField[] = [];

    ctx.graph.forEachNode((node) => {
      if (node.label !== 'Property') return;
      if (node.properties.language !== 'java') return;
      // Injection-annotation gate: only fields the container actually
      // injects (@Autowired / @Inject) are candidates. Plain collection
      // fields are never injected; @Resource is deliberately excluded
      // (by-name-first semantics — see INJECTION_ANNOTATIONS).
      const matchedAnnotation = node.properties.annotations?.find((a) =>
        INJECTION_ANNOTATIONS.has(a),
      );
      if (matchedAnnotation === undefined) return;
      // Match on rawDeclaredType ONLY — no `?? declaredType` fallback:
      // production `declaredType` is generics-stripped by design, so a
      // fallback can never match real data and would only mask plumbing
      // regressions as quiet no-ops.
      const rawDeclaredType = node.properties.rawDeclaredType;
      if (!rawDeclaredType) {
        // An injection-annotated field with NO rawDeclaredType means the
        // extraction plumbing broke its contract (U1 threads the raw type
        // wherever annotations are threaded) — surface it, don't silently drop.
        if (isDev) {
          logger.warn(
            `Spring DI: annotated field '${node.properties.name}' (${node.properties.filePath}) has no rawDeclaredType — extraction plumbing contract breach; skipping`,
          );
        }
        return;
      }
      const parsed = parseSpringCollectionType(rawDeclaredType);
      if (!parsed) return;
      candidates.push({
        propertyId: node.id,
        collectionType: parsed.collectionType,
        elementTypeName: parsed.elementTypeName,
        matchedAnnotation,
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
          // Honest reason: states the annotation actually found on the field.
          reason: `Spring DI: ${candidate.matchedAnnotation} ${candidate.collectionType}<${candidate.elementTypeName}>`,
        });
        injectsEdges++;
      }
    }

    if (isDev && injectsEdges > 0) {
      logger.info(
        `🌱 Spring DI: ${injectsEdges} INJECTS edges from ${candidates.length} injection-annotated collection fields`,
      );
    }

    return { injectsEdges, fieldsScanned: candidates.length };
  },
};
