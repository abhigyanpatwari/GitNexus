/**
 * Per-language DI field-matcher registry — the lookup the generic `di`
 * pipeline phase uses to decide whether a `Property` node is a
 * dependency-injection fan-out candidate.
 *
 * Mirrors `scope-resolution/pipeline/registry.ts` (`SCOPE_RESOLVERS`): a
 * single-valued `ReadonlyMap<SupportedLanguages, DiFieldMatcher>` consumed by
 * a framework-neutral phase, so no language or framework names leak into
 * shared pipeline code. Adding a framework is two lines: implement a
 * `DiFieldMatcher` in `di-extractors/<framework>.ts` and register it here.
 *
 * Scope honesty: matchers are per-language *field-injection* matchers.
 * Constructor injection (the dominant modern Spring idiom) lives on
 * Method/parameter nodes and would require widening the phase's routing —
 * deliberately out of scope (see the plan's Deferred work). The registry is
 * single-valued per language, matching the `SCOPE_RESOLVERS` shape; widen the
 * value type to arrays only when a second same-language framework actually
 * lands (a one-line type change then).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { GraphNode } from 'gitnexus-shared';
import { springDiFieldMatcher } from './spring.js';

/** A successful DI field match, produced by a per-language matcher. */
export interface DiFieldMatch {
  /** The element type name `T` — the injected bean interface. */
  elementTypeName: string;
  /** Human-readable edge reason. Framework specifics (names, idioms,
   *  collection wrapper, gating annotation) live in this payload so the
   *  shared `di` phase stays framework-neutral. */
  reason: string;
}

/**
 * A per-language field-injection matcher: given a `Property` node, return the
 * parsed DI match or `null` when the field is not container-injected. The
 * matcher receives the whole node (not pre-plucked fields) so the shared
 * phase stays ignorant of which properties matter.
 */
export type DiFieldMatcher = (node: GraphNode) => DiFieldMatch | null;

/** All `SupportedLanguages` string values, for narrowing raw graph strings. */
const SUPPORTED_LANGUAGE_VALUES: ReadonlySet<string> = new Set(Object.values(SupportedLanguages));

/**
 * Type guard narrowing an arbitrary graph `language` string to
 * `SupportedLanguages`, so `DI_MATCHERS.get()` needs no cast.
 */
export function isSupportedLanguage(value: string): value is SupportedLanguages {
  return SUPPORTED_LANGUAGE_VALUES.has(value);
}

/** Map of `SupportedLanguages` → `DiFieldMatcher`. The `di` phase routes each
 *  `Property` node here by `node.properties.language`; no entry ⇒ the node is
 *  skipped. This is the single source of truth for which languages (and,
 *  transitively, frameworks) produce INJECTS edges. */
export const DI_MATCHERS: ReadonlyMap<SupportedLanguages, DiFieldMatcher> = new Map<
  SupportedLanguages,
  DiFieldMatcher
>([[SupportedLanguages.Java, springDiFieldMatcher]]);
