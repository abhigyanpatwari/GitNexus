/**
 * Spring dependency-injection field matcher for the generic `di` phase.
 *
 * Recognizes the fields Spring's container fills via collect-all-implementers
 * collection injection: when a Java class declares a field carrying an
 * injection annotation (`@Autowired` or `@Inject`) typed as `List<T>`,
 * `Set<T>`, `Collection<T>`, or `Map<K,T>`, the container injects EVERY bean
 * implementing interface `T`. The matcher reports the collection wrapper, the
 * element type name `T`, and the annotation that gated the match; the shared
 * `di` phase turns that into `INJECTS` edges.
 *
 * The injection annotation is a hard precondition: a plain (non-annotated)
 * collection field is never injected by the container and produces no match.
 * `@Resource` (JSR-250) is DELIBERATELY excluded: it resolves by bean NAME
 * first (defaulting to the field name), which injects a single named
 * collection bean — the opposite of the collect-all-implementers fan-out
 * INJECTS models. Including it would emit false edges.
 *
 * Matching happens on `rawDeclaredType` (the verbatim type text, generics
 * preserved) — NOT `declaredType`, which is generics-stripped by design
 * (`List<Shape>` → `List`) and can never match the collection patterns.
 *
 * Registered under `SupportedLanguages.Java` in `./index.ts` (`DI_MATCHERS`);
 * language routing is the registry's job, so the matcher itself never reads
 * `node.properties.language`.
 */

import type { GraphNode } from 'gitnexus-shared';
import type { DiFieldMatch, DiFieldMatcher } from './index.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

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

/**
 * Match a `Property` node against Spring's collection-injection shape.
 *
 * Returns the parsed match (with a Spring-specific human-readable `reason`
 * payload) or `null` when the field is not container-injected.
 */
export const springDiFieldMatcher: DiFieldMatcher = (node: GraphNode): DiFieldMatch | null => {
  // Injection-annotation gate: only fields the container actually
  // injects (@Autowired / @Inject) are candidates. Plain collection
  // fields are never injected; @Resource is deliberately excluded
  // (by-name-first semantics — see INJECTION_ANNOTATIONS).
  const matchedAnnotation = node.properties.annotations?.find((a) => INJECTION_ANNOTATIONS.has(a));
  if (matchedAnnotation === undefined) return null;
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
    return null;
  }
  const parsed = parseSpringCollectionType(rawDeclaredType);
  if (!parsed) return null;
  return {
    collectionType: parsed.collectionType,
    elementTypeName: parsed.elementTypeName,
    matchedAnnotation,
    // Honest reason: states the annotation actually found on the field.
    // Framework specifics live HERE, in the payload — never in the phase.
    reason: `Spring DI: ${matchedAnnotation} ${parsed.collectionType}<${parsed.elementTypeName}>`,
  };
};
