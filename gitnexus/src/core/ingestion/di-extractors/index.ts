/**
 * Per-language DI resolver registry — the lookup the generic `di` pipeline
 * phase uses to discover injection sites and provider metadata on graph nodes.
 *
 * Mirrors `scope-resolution/pipeline/registry.ts` (`SCOPE_RESOLVERS`): a
 * single-valued `ReadonlyMap<SupportedLanguages, DiResolver>` consumed by
 * a framework-neutral phase, so no language or framework names leak into
 * shared pipeline code. Adding a framework means implementing a `DiResolver`
 * in `di-extractors/<framework>.ts` and registering it here.
 *
 * The registry is single-valued per language, matching the `SCOPE_RESOLVERS`
 * shape; widen the value type to arrays only when a second same-language
 * framework actually lands. Java and Kotlin share Spring's attached metadata
 * contract while retaining language-specific syntax capture.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { GraphNode } from 'gitnexus-shared';
import { springDiResolver } from './spring.js';

/** A successful injection-site match, produced by a per-language resolver. */
export interface DiInjectionMatch {
  /** The requested dependency type name. */
  targetTypeName: string;
  /** A collection receives every matching provider; a single site may need
   *  framework-specific named/preferred-provider disambiguation. */
  cardinality: 'single' | 'collection';
  /** Statically known provider name requested at the injection site. The
   *  resolver owns the human-readable explanation of that selection. */
  namedSelection?: {
    name: string;
    reason: string;
  };
  /** Human-readable edge reason. Framework specifics (names, idioms,
   *  collection wrapper, gating annotation) live in this payload so the
   *  shared `di` phase stays framework-neutral. */
  reason: string;
}

/** Provider metadata used by the shared resolver without naming a framework. */
export interface DiProviderMatch {
  /** Provider names and aliases that can satisfy a named injection. */
  names: readonly string[];
  /** Present when the framework marks this as its preferred candidate. The
   *  value is appended to the emitted edge reason when it disambiguates. */
  preferenceReason?: string;
}

/** Per-language DI behavior. Matchers receive whole nodes so the shared phase
 * remains ignorant of language/framework-specific property shapes. */
export interface DiResolver {
  matchInjectionSites(node: GraphNode): readonly DiInjectionMatch[];
  matchProvider(node: GraphNode): DiProviderMatch | null;
}

/** All `SupportedLanguages` string values, for narrowing raw graph strings. */
const SUPPORTED_LANGUAGE_VALUES: ReadonlySet<string> = new Set(Object.values(SupportedLanguages));

/**
 * Type guard narrowing an arbitrary graph `language` string to
 * `SupportedLanguages`, so `DI_RESOLVERS.get()` needs no cast.
 */
export function isSupportedLanguage(value: string): value is SupportedLanguages {
  return SUPPORTED_LANGUAGE_VALUES.has(value);
}

/** Map of `SupportedLanguages` → `DiResolver`. The `di` phase routes each
 *  graph node here by `node.properties.language`; no entry ⇒ the node is
 *  skipped. This is the single source of truth for which languages (and,
 *  transitively, frameworks) produce INJECTS edges. */
export const DI_RESOLVERS: ReadonlyMap<SupportedLanguages, DiResolver> = new Map<
  SupportedLanguages,
  DiResolver
>([
  [SupportedLanguages.Java, springDiResolver],
  [SupportedLanguages.Kotlin, springDiResolver],
]);
