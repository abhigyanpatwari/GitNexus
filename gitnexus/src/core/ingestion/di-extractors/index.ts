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
import type { DiResolver } from './types.js';
import { springDiResolver } from './spring.js';

/** The resolver contract lives in the leaf `./types.js` so an implementation
 *  can depend on it without depending on this registry (which imports every
 *  implementation). The two match shapes are re-exported here because consumers
 *  of the registry read them off its results — `pipeline-phases/di.ts` and the
 *  Spring metadata modules import them from this module alongside
 *  `DI_RESOLVERS`. `DiResolver` itself is NOT re-exported: only implementations
 *  need it, and they import it from `./types.js` directly. */
export type { DiInjectionMatch, DiProviderMatch } from './types.js';

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
