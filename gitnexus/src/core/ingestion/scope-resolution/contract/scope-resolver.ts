/**
 * `ScopeResolver` — the per-language contract consumed by the generic
 * scope-resolution orchestrator (`runScopeResolution`).
 *
 * ## Migration cookbook (next language)
 *
 * To add a language to the registry-primary path:
 *
 *   1. Implement `ScopeResolver` in
 *      `gitnexus/src/core/ingestion/languages/<lang>/scope-resolver.ts`.
 *      Six required fields (language, languageProvider,
 *      importEdgeReason, resolveImportTarget, mergeBindings,
 *      arityCompatibility, buildMro, populateOwners, isSuperReceiver)
 *      plus two optional booleans (propagatesReturnTypesAcrossImports,
 *      fieldFallbackOnMethodLookup).
 *   2. Export a thin entry point:
 *      `runYourLangScopeResolution(input) = runScopeResolution(input, yourScopeResolver)`.
 *   3. Register the provider in
 *      `gitnexus/src/core/ingestion/scope-resolution/pipeline/registry.ts`
 *      (the `SCOPE_RESOLVERS` map).
 *   4. Add `SupportedLanguages.YourLang` to `MIGRATED_LANGUAGES` in
 *      `registry-primary-flag.ts`.
 *   5. Verify the resolver integration test at
 *      `gitnexus/test/integration/resolvers/<lang>.test.ts` passes
 *      under both `REGISTRY_PRIMARY_<LANG>=0` (legacy) and `=1`
 *      (registry-primary). The CI parity gate enforces this.
 *
 * No new pipeline phase, no orchestrator copy-paste, no workflow
 * change. The generic `scopeResolutionPhase` and the CI parity
 * workflow auto-discover everything via `MIGRATED_LANGUAGES`.
 *
 * ## ScopeResolver vs LanguageProvider
 *
 * The codebase has two provider contracts. Their lifecycles differ:
 *
 *   - `LanguageProvider` (`language-provider.ts`) is the
 *     **parsing-side** contract — how to emit captures, classify
 *     scopes, interpret imports / typeBindings. ~40 fields covering
 *     both legacy and new pipelines. Consumed by `ScopeExtractor`,
 *     once per file at extract time.
 *   - `ScopeResolver` (this file) is the **emit-side** contract — how
 *     the resolution pipeline dispatches references to graph edges.
 *     8 fields total. Consumed by `runScopeResolution`, once per
 *     workspace at resolve time.
 *
 * They share three concept names (`arityCompatibility`, `mergeBindings`,
 * `resolveImportTarget`) because the emit pipeline reuses a few
 * finalize hooks. Per-language wiring passes the SAME function
 * reference through both interfaces — no second copy of the logic.
 * Rationale for not collapsing: lifecycle separation, and merging
 * would create a god-interface complicating future migrations.
 *
 * ## Reference implementation
 *
 * `gitnexus/src/core/ingestion/languages/python/scope-resolver.ts` —
 * `pythonScopeResolver` is the canonical example. Read that file when
 * migrating a new language; this interface lists the fields that
 * implementation populates.
 *
 * ## Contract Invariants the orchestrator depends on
 *
 * (See the plan for the full list. Highlights only here.)
 *
 *   - **I1 — Phase 4 emission order is load-bearing.** Receiver-bound
 *     pass FIRST, then free-call fallback, then `emitReferencesViaLookup`.
 *   - **I3 — `propagateImportedReturnTypes` runs after finalize and
 *     before `resolveReferenceSites`.** It mutates non-frozen
 *     `Scope.typeBindings`. Do not freeze typeBindings in any
 *     downstream refactor.
 *   - **I5 — Pre-seeding `seen` from `referenceIndex` is forbidden.**
 *     The receiver-bound pass relies on this never happening.
 *
 * Plan: `docs/plans/2026-04-20-001-refactor-emit-pipeline-generalization-plan.md`.
 */

import type {
  BindingRef,
  Callsite,
  ParsedFile,
  ScopeId,
  SupportedLanguages,
  SymbolDefinition,
} from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { LanguageProvider } from '../../language-provider.js';

/** A LinearizeStrategy receives the full ancestor map so C3-style
 *  algorithms (which need to merge each parent's MRO) can implement
 *  themselves. Python's depth-first first-seen only consumes
 *  `directParents` and `parentsByDefId`. */
export type LinearizeStrategy = (
  classDefId: string,
  directParents: readonly string[],
  parentsByDefId: ReadonlyMap<string, readonly string[]>,
) => string[];

/** Result of `ScopeResolver.arityCompatibility` — mirrors `RegistryProviders.arityCompatibility`. */
export type ArityVerdict = 'compatible' | 'unknown' | 'incompatible';

export interface ScopeResolver {
  /** Identity for telemetry + per-language flag check. */
  readonly language: SupportedLanguages;

  /** Parsing-side hook bag consumed by `extractParsedFile`. The
   *  same `LanguageProvider` reference flows through both interfaces
   *  to keep parsing and emit semantics in sync. */
  readonly languageProvider: LanguageProvider;

  /** Reason text on emitted IMPORTS edges. Mirrors the legacy DAG's
   *  per-language convention so consumers asserting on reason keep
   *  working. */
  readonly importEdgeReason: string;

  // ─── Pipeline hooks ────────────────────────────────────────────────────────

  /**
   * Resolve an import statement's `targetRaw` (e.g. `models.user`,
   * `./helpers`) into an absolute repo-relative file path, or `null`
   * for unresolvable / external modules.
   *
   * Called once per `ParsedImport` during `finalizeScopeModel`. The
   * Python implementation wraps `resolvePythonImportTarget`.
   *
   * `allFilePaths` is the workspace's file set — needed by per-language
   * resolvers that must distinguish "this module exists in the repo"
   * from "this module is external" (Python's fallback resolver, for
   * example).
   */
  resolveImportTarget(
    targetRaw: string,
    fromFile: string,
    allFilePaths: ReadonlySet<string>,
  ): string | null;

  /**
   * Per-scope binding-merge precedence. The shared finalize pass
   * collects bindings from multiple sources (local declarations,
   * imports, namespace, wildcard, reexport) and asks the language
   * how to order them.
   *
   * Python uses LEGB: local > import / namespace / reexport > wildcard.
   */
  mergeBindings(
    existing: readonly BindingRef[],
    incoming: readonly BindingRef[],
    scopeId: ScopeId,
  ): BindingRef[];

  /**
   * Per-language arity compatibility between a callsite and a
   * candidate def. The shared `MethodRegistry.lookup` consults this
   * to penalize incompatible candidates without disqualifying them
   * outright. Note arg order — `(callsite, def)` matches the
   * `RegistryProviders` contract; some legacy provider impls use
   * `(def, callsite)` and need an adapter at the wiring site.
   */
  arityCompatibility(callsite: Callsite, def: SymbolDefinition): ArityVerdict;

  // ─── Per-language strategies ───────────────────────────────────────────────

  /**
   * Compute the method-dispatch order for every Class def in the
   * workspace. Python uses depth-first first-seen via
   * `pythonLinearize`; future languages may use C3 (Ruby, Python's
   * real MRO when we go beyond the simplified walk), single-
   * inheritance only (Java), or empty-map (languages without
   * inheritance).
   */
  buildMro(
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
  ): Map<string /* DefId */, string[] /* ancestor DefIds */>;

  /**
   * Mutate `parsed.localDefs[i].ownerId` to point at the structural
   * owner. Python's rule: methods (Function defs whose parent scope
   * is Class) AND class-body fields (defs in Class scopes) are owned
   * by the enclosing class. Other languages may have richer rules
   * (e.g., Java inner-class qualification).
   */
  populateOwners(parsed: ParsedFile): void;

  /**
   * Recognize a `super(...)`-style receiver text. Python returns
   * `/^super\s*\(/.test(t)`. Java returns `t === 'super'`. C++ may
   * also need `this` capture. Languages without inheritance return
   * constant `false`.
   */
  isSuperReceiver(receiverText: string): boolean;

  // ─── Optional toggles ──────────────────────────────────────────────────────

  /**
   * Whether the orchestrator should run `propagateImportedReturnTypes`
   * after finalize. Default `true`. TypeScript with explicit type
   * exports may want a different propagation strategy and opt out.
   */
  readonly propagatesReturnTypesAcrossImports?: boolean;

  /**
   * Whether the compound-receiver resolver should fall back to
   * walking field types when method lookup on the receiver's class
   * fails (the "Phase-9C unified fixpoint" heuristic). Default
   * `true`. Strictly-typed languages should set `false` because the
   * heuristic can produce edges that wouldn't survive a real type
   * check.
   */
  readonly fieldFallbackOnMethodLookup?: boolean;
}
