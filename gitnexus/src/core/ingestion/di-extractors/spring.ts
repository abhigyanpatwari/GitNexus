/**
 * Spring dependency-injection field matcher for the generic `di` phase.
 *
 * Recognizes the fields Spring's container fills via collect-all-implementers
 * collection injection: when a Java class declares a field carrying an
 * injection annotation (`@Autowired` or `@Inject`) typed as `List<T>`,
 * `Set<T>`, `Collection<T>`, or `Map<K,T>`, the container injects EVERY bean
 * implementing interface `T`. The matcher reports the element type name `T`
 * plus a human-readable reason naming the collection wrapper and the
 * annotation that gated the match; the shared `di` phase turns that into
 * `INJECTS` edges.
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
 * Accepted type shapes (after whitespace normalization — internal runs of
 * whitespace, including newlines from multi-line declarations, collapse to a
 * single space):
 * - `List<T>` / `Set<T>` / `Collection<T>` — element `T`.
 * - `Map<K, T>` — element is the VALUE type `T`; the key `K` is irrelevant
 *   for DI resolution and may itself be generic (`Map<Pair<A,B>, T>` — the
 *   top-level-comma split is bracket-depth-aware, so nested commas in the
 *   key never bleed into the element).
 * - Bounded wildcards `List<? extends T>` / `List<? super T>` — element `T`
 *   (both are idiomatic Spring collection injection; the container still
 *   collects every implementer of `T`).
 * - Package-qualified wrappers `java.util.List<T>` — the wrapper is
 *   recognized by its LAST dotted segment. The ELEMENT keeps its dots
 *   (`List<com.a.Shape>` → `com.a.Shape`): dotted element names resolve via
 *   `qualifiedName` downstream in the `di` phase.
 *
 * Documented REJECTIONS (parse returns `null` — no INJECTS edges):
 * - `Map<String, List<IFoo>>` — the element itself is generic; a nested
 *   generic is not resolvable as a single interface.
 * - `List<?>` — unbounded wildcard; there is no element type to fan out to.
 * - Arrays: `IFoo[]`, `List<IFoo>[]`, `List<IFoo[]>` — array injection is
 *   not the collect-all-implementers shape INJECTS models.
 * - Non-collection types (`IFoo`, `Optional<IFoo>`, …) and wrong generic
 *   arity (`Map<String>`, `List<A, B>`).
 * - Anything whose element is not a plain (possibly dotted) Java type name —
 *   this makes the parser fail closed on unanticipated syntax. In particular
 *   Java block comments inside the generic arguments (a `/* ... ` comment
 *   between `<` and the element) are NOT stripped and fail closed —
 *   acceptable.
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

/** Collection wrappers whose generic element Spring fans out to every
 *  implementer. `Map` is special-cased for arity (2 args, element = value). */
const COLLECTION_WRAPPERS: ReadonlySet<string> = new Set(['List', 'Set', 'Collection', 'Map']);

/** Bounded-wildcard prefixes stripped from the element position (single-spaced
 *  — the input is whitespace-normalized before these are checked). */
const WILDCARD_EXTENDS_PREFIX = '? extends ';
const WILDCARD_SUPER_PREFIX = '? super ';

/** A plain (possibly dotted) Java type name — the only element shape the
 *  parser accepts. Everything else (wildcards, arrays, comments, stray
 *  punctuation) fails closed. */
const JAVA_TYPE_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/**
 * Split a generic-argument list on TOP-LEVEL commas only, tracking `<`/`>`
 * bracket depth so nested generics (e.g. the `Pair<A,B>` key in
 * `Map<Pair<A,B>, IFoo>`) never split mid-argument.
 *
 * @returns the top-level argument segments (untrimmed), or `null` when the
 *          brackets are unbalanced (fail closed on malformed input).
 */
function splitTopLevelGenericArgs(inner: string): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      depth--;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      args.push(inner.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  if (depth !== 0) return null;
  args.push(inner.slice(segmentStart));
  return args;
}

/**
 * Extract the injected bean type name from one (whitespace-normalized)
 * generic-argument segment: strip a bounded-wildcard prefix, then require a
 * plain dotted Java type name.
 *
 * @returns the element type name, or `null` for unbounded wildcards, nested
 *          generics, arrays, and any other non-type-name shape (fail closed).
 */
function parseElementTypeName(segment: string): string | null {
  let element = segment.trim();
  // Bounded wildcards are idiomatic collection injection: the container
  // still collects every implementer of the bound.
  if (element.startsWith(WILDCARD_EXTENDS_PREFIX)) {
    element = element.slice(WILDCARD_EXTENDS_PREFIX.length);
  } else if (element.startsWith(WILDCARD_SUPER_PREFIX)) {
    element = element.slice(WILDCARD_SUPER_PREFIX.length);
  }
  // Final gate: a plain (possibly dotted) type name. Rejects nested generics
  // (`Map<String, List<IFoo>>` — not resolvable as a single interface),
  // arrays (`List<IFoo[]>` — not the fan-out shape INJECTS models), the
  // unbounded wildcard `?`, un-stripped comments, and any other residue —
  // all documented rejections; fail closed.
  if (!JAVA_TYPE_NAME_PATTERN.test(element)) return null;
  return element;
}

/**
 * Parse a Spring DI collection field's raw declared type (verbatim source
 * text, generics preserved) and return the injected bean type name.
 *
 * Whitespace-normalizes first (raw tree-sitter `.text` can span lines), then
 * recognizes the wrapper by the LAST dotted segment before the first `<`
 * (so `java.util.List<IFoo>` works), depth-aware-splits the generic argument
 * list, and validates the element position. See the module docstring for the
 * full accepted/rejected shape inventory.
 *
 * @returns the collection wrapper name + element type name, or `null` when
 *          the raw declared type is not a recognized Spring collection shape.
 */
export function parseSpringCollectionType(
  rawDeclaredType: string,
): { collectionType: string; elementTypeName: string } | null {
  // Collapse ALL internal whitespace runs (spaces, tabs, newlines from
  // multi-line declarations) to single spaces, then trim the ends.
  const normalized = rawDeclaredType.replace(/\s+/g, ' ').trim();
  const openIndex = normalized.indexOf('<');
  // No generic argument list, or trailing residue after the closing `>`
  // (e.g. the array suffix in `List<IFoo>[]`) — not a collection injection.
  if (openIndex === -1 || !normalized.endsWith('>')) return null;
  // Wrapper = last dotted segment of the pre-`<` text: strips a package
  // qualifier from the WRAPPER only (`java.util.List` → `List`).
  const wrapperPath = normalized.slice(0, openIndex).trim();
  const wrapperSegments = wrapperPath.split('.');
  const wrapper = wrapperSegments[wrapperSegments.length - 1];
  if (!COLLECTION_WRAPPERS.has(wrapper)) return null;
  const inner = normalized.slice(openIndex + 1, normalized.length - 1);
  const args = splitTopLevelGenericArgs(inner);
  if (args === null) return null;
  // List/Set/Collection take exactly one type argument; Map exactly two,
  // and the injected bean type is the VALUE (2nd argument) — the key is
  // irrelevant for DI resolution.
  const expectedArity = wrapper === 'Map' ? 2 : 1;
  if (args.length !== expectedArity) return null;
  const elementTypeName = parseElementTypeName(args[expectedArity - 1]);
  if (elementTypeName === null) return null;
  return { collectionType: wrapper, elementTypeName };
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
    elementTypeName: parsed.elementTypeName,
    // Honest reason: states the annotation actually found on the field and
    // the collection wrapper it gated. Framework specifics live HERE, in the
    // payload — never in the phase.
    reason: `Spring DI: ${matchedAnnotation} ${parsed.collectionType}<${parsed.elementTypeName}>`,
  };
};
