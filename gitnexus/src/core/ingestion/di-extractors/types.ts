/**
 * The DI resolver contract — the types a per-language/per-framework resolver
 * implements and the shared `di` pipeline phase consumes.
 *
 * A leaf module by design: it imports nothing from this directory, so the
 * barrel (`./index.ts`, which aggregates the resolver *implementations*) and
 * each implementation (`./spring.ts`) can both depend on the contract without
 * depending on each other. The barrel re-exports the two MATCH types, because
 * consumers of the registry read them off its results; `DiResolver` is not
 * re-exported, since only implementations need it and they import it from here
 * directly.
 */

import type { GraphNode } from 'gitnexus-shared';

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
    /** Name-first frameworks may fall back to type only for implicit/default
     * names. Explicit names remain strict. */
    fallbackToType?: boolean;
  };
  /** Most injection edges originate at the owning Class. Factory-method
   * parameters preserve the Method as the semantic source. */
  edgeSource?: 'owner-class' | 'site';
  /** Human-readable edge reason. Framework specifics (names, idioms,
   *  collection wrapper, gating annotation) live in this payload so the
   *  shared `di` phase stays framework-neutral. */
  reason: string;
}

/** Provider metadata used by the shared resolver without naming a framework. */
export interface DiProviderMatch {
  /** Provider names and aliases that can satisfy a named injection. */
  names: readonly string[];
  /** Optional type directly provided by a declaration node, such as a
   * framework factory method whose node is not itself a Class. */
  providedTypeName?: string;
  /** Graph node that declares this provider. The shared phase excludes a
   * provider from injection into its own declaration site without knowing the
   * framework-specific declaration model. */
  declaredByNodeId?: string;
  /** Global preference for every injectable type (e.g. Spring `@Primary`).
   *  Used only when `preferenceByType` is omitted. */
  preferenceReason?: string;
  /** Type-scoped preference reasons (type name → reason). An empty object
   *  means no type-scoped preference. Qualified keys must not win injections
   *  of a differently-qualified same short name. */
  preferenceByType?: Readonly<Record<string, string>>;
}

/** Per-language DI behavior. Matchers receive whole nodes so the shared phase
 * remains ignorant of language/framework-specific property shapes. */
export interface DiResolver {
  matchInjectionSites(node: GraphNode): readonly DiInjectionMatch[];
  matchProvider(node: GraphNode): DiProviderMatch | null;
}
