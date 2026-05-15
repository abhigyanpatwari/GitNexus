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
 *      Nine required fields (language, languageProvider,
 *      importEdgeReason, resolveImportTarget, mergeBindings,
 *      arityCompatibility, buildMro, populateOwners, isSuperReceiver)
 *      plus optional toggles / hooks:
 *        - propagatesReturnTypesAcrossImports (default true)
 *        - fieldFallbackOnMethodLookup (default true — turn OFF for
 *          statically-typed languages; the heuristic over-connects)
 *        - unwrapCollectionAccessor — property-style collection views
 *        - collapseMemberCallsByCallerTarget — one edge per caller/target
 *        - populateNamespaceSiblings — cross-file implicit visibility
 *        - hoistTypeBindingsToModule — enable ONLY when method return
 *          types are stored on the enclosing Module scope; most
 *          languages attach them to the class scope and leave this off
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
 * These are non-obvious behaviors that the orchestrator and the
 * existing Python + C# resolvers depend on. Future implementers will
 * break them silently if not documented.
 *
 *   - **I1 — Phase 4 emission order is load-bearing.** `emitReceiverBoundCalls`
 *     runs FIRST (populates `handledSites`), then `emitFreeCallFallback`,
 *     then `emitReferencesViaLookup` (consumes `handledSites` as a skip
 *     set), then `emitImportEdges`. Reordering breaks same-name collision
 *     resolution: the shared lookup can mis-resolve `app_metrics.get_metrics()`
 *     to a same-named local function, and only the precise per-receiver
 *     pass running first prevents the wrong edge.
 *
 *   - **I2 — `handledSites` semantics.** A site is added to
 *     `handledSites` IFF a `tryEmitEdge` call returned `true` for it.
 *     Sites a pass touched but couldn't resolve do NOT get marked —
 *     they still get a chance from the shared resolver. Exception:
 *     the free-call fallback marks the site unconditionally after
 *     attempting emission (even on dedup-collapse), because the
 *     per-(caller, target) collapse semantics require multiple call
 *     sites in the same caller body not produce multiple edges.
 *     `preEmitInheritanceEdges` also pre-marks every `inherits` site so
 *     the generic bridge cannot remap class heritage into method-owned
 *     EXTENDS edges via `resolveCallerGraphId`.
 *
 *   - **I3 — `propagateImportedReturnTypes` mutation timing + ordering.**
 *     The pass mutates `Scope.typeBindings` (a plain `new Map(...)` from
 *     `draftToScope`, NOT frozen). It MUST run AFTER `finalizeScopeModel`
 *     (so `indexes.bindings` is populated) and BEFORE
 *     `resolveReferenceSites` (so resolution sees the propagated types).
 *     The pass also re-runs `followChainPostFinalize` on every scope's
 *     typeBindings because scope-extractor's pass-4 already ran and
 *     missed any chain whose terminal lives in a foreign file.
 *     Within the pass, files are walked in `indexes.sccs` reverse-
 *     topological order (leaves first) so multi-hop alias chains
 *     (e.g. `models.User → service.user → app.user`) collapse to the
 *     terminal class in a single pass — every importer sees its
 *     source's already-chain-followed typeBindings. Cyclic SCCs reach
 *     a partial fixpoint within a single pass without iterating to
 *     convergence; `ts-circular` only asserts pipeline-no-throw.
 *
 *   - **I4 — `emitReceiverBoundCalls` case order.** Cases are evaluated
 *     in this order; the FIRST that emits an edge wins:
 *       1. super branch (`provider.isSuperReceiver(receiverName)`)
 *       2. Case 0 compound (`receiverName` has `.` or `(`)
 *       3. Case 1 namespace-receiver
 *       4. Case 2 class-name receiver
 *       5. Case 3 dotted typeBinding for namespace prefix
 *       6. Case 3b chain-typebinding (compound resolver)
 *       7. Case 4 simple typeBinding (MRO walk + findOwnedMember)
 *     Reordering or merging cases changes resolution semantics. The
 *     numbering is part of the contract — keep the comments.
 *
 *   - **I5 — Pre-seeding `seen` from `referenceIndex` is forbidden.**
 *     Earlier versions of the receiver-bound pass pre-populated `seen`
 *     to avoid double-emit. After Phase 4 was reordered, pre-seeding
 *     became actively harmful: it suppresses correct emissions for
 *     sites the shared resolver happened to resolve to a wrong target.
 *     The orchestrator MUST NOT pre-seed.
 *
 *   - **I6 — `Scope.typeBindings` is mutable post-finalize.** `draftToScope`
 *     (in `scope-extractor.ts`) builds `typeBindings` as a plain
 *     `new Map(...)` — not frozen, intentionally. Passes below rely on
 *     this. Do NOT freeze `typeBindings` in any downstream refactor.
 *
 *   - **I7 — `ScopeResolver` and `LanguageProvider` are distinct contracts.**
 *     Python and C# pass the SAME function reference through both
 *     interfaces where they share a hook name — no second copy of the
 *     logic. Rationale for not collapsing them: lifecycles differ
 *     (parsing-side runs once per file at extract time, emit-side runs
 *     once per workspace at resolve time), and merging would create a
 *     god-interface that complicates future migrations.
 *
 *   - **I8 — Two-channel binding lifecycle.**
 *     `indexes.bindings` is the **finalize-output channel**. After
 *     `finalizeScopeModel` returns, its inner `BindingRef[]` arrays
 *     are deep-frozen by `materializeBindings` and MUST NOT be
 *     mutated by any post-finalize hook. Treat `indexes.bindings` as
 *     immutable from the moment `finalizeScopeModel` returns.
 *
 *     `indexes.bindingAugmentations` is the **post-finalize
 *     append-only channel**. Hooks like `populateNamespaceSiblings`
 *     append cross-file bindings synthesized after finalize (C#
 *     same-namespace visibility, `using static` member exposure)
 *     into this channel, NOT into `indexes.bindings`. Inner arrays
 *     here are NEVER frozen — hooks `push()` directly. Any consumer
 *     that reads post-finalize workspace bindings MUST query both
 *     index channels via `lookupBindingsAt`
 *     (`scope-resolution/scope/walkers.ts`); the helper returns
 *     finalized refs first, appends unique augmentation refs after,
 *     and dedupes by `def.nodeId` so finalized metadata wins on
 *     duplicate defs. Per-`Scope.bindings` local declarations are the
 *     lexical extraction channel and remain a separate first-tier
 *     lookup for local shadowing.
 *
 *     `Scope.typeBindings` remains mutable post-finalize per I6 (it
 *     is intentionally not frozen at any point).
 *
 *     The `ReadonlyMap<...>` types on `ScopeResolutionIndexes` are
 *     compile-time read-guidance for consumers; structural mutation
 *     of `bindingAugmentations` is performed via a deliberate
 *     `as Map<...>` cast inside the hook implementations and is the
 *     ONLY sanctioned channel for post-finalize binding fanout.
 *
 *     The dev-mode runtime validator
 *     (`validateBindingsImmutability` in
 *     `scope-resolution/validate-bindings-immutability.ts`) surfaces
 *     any drift — i.e. a hook writing to `indexes.bindings` instead
 *     of `bindingAugmentations`, or producing a non-frozen finalized
 *     bucket — via `onWarn` when explicitly enabled by
 *     `NODE_ENV === 'development' || VALIDATE_SEMANTIC_MODEL === '1'`
 *     (`VALIDATE_SEMANTIC_MODEL=0` is an explicit off switch).
 *
 *   - **I9 — `SemanticModel` is the single authoritative symbol store.**
 *     Every symbol-indexed lookup (key = `nodeId | simpleName |
 *     qualifiedName | filePath`) resolves through
 *     `SemanticModel.{symbols,types,methods,fields}`. Scope-resolution
 *     passes MUST NOT maintain parallel owner-keyed or name-keyed
 *     symbol indexes — `WorkspaceResolutionIndex` is reserved for
 *     `Scope`-valued lookups that `SemanticModel` structurally cannot
 *     carry.
 *
 *     The `runScopeResolution` orchestrator guarantees this invariant
 *     in two steps:
 *       1. The legacy `parse` phase populates `SemanticModel` via
 *          `symbolTable.add(...)`. For languages whose extractor
 *          resolves `enclosingClassId` at parse time, class-body defs
 *          are correctly owner-keyed there.
 *       2. The `reconcileOwnership` pass runs after
 *          `provider.populateOwners(parsed)` and registers any def in
 *          `parsed.localDefs[i]` with a corrected `ownerId` that the
 *          legacy pass missed (primarily Python class-body methods).
 *          Idempotent — duplicates are skipped by `nodeId`.
 *
 *     Contract for consumers: `model` is `MutableSemanticModel` only
 *     during those two write phases. Downstream passes receive a
 *     narrowed `SemanticModel` (read-only) handle. This is enforced by
 *     `runScopeResolution`'s type-level narrowing at the phase
 *     boundary.
 *
 *     The dev-mode runtime validator (`validateOwnershipParity`)
 *     surfaces any drift between `parsed.localDefs` ownership and the
 *     registries via `onWarn` when
 *     `NODE_ENV !== 'production' && VALIDATE_SEMANTIC_MODEL !== '0'`.
 *
 *     This invariant is a **transitional shim**: the architectural
 *     end state is for every language's parse-time extractor to emit
 *     the correct `ownerId` directly, removing the need for
 *     reconciliation. Tracked as a follow-up; see ARCHITECTURE.md §
 *     "Semantic-model source of truth".
 *
 * ## Semantic-model source of truth
 *
 * `ParsedFile` (from `gitnexus-shared/src/scope-resolution/parsed-file.ts`)
 * is the single semantic model consumed by both the legacy DAG and the
 * scope-resolution pipeline. Scope-resolution passes MUST NOT build a
 * parallel parse representation; if a pass needs AST-level facts that
 * `ParsedFile` doesn't expose, it should reuse the orchestrator's
 * `treeCache` (see `RunScopeResolutionInput.treeCache`) rather than
 * re-invoke `parser.parse(...)` on its own.
 *
 * ## Same-graph guarantee
 *
 * Edges emitted by `runScopeResolution` and edges emitted by the legacy
 * DAG are indistinguishable to downstream consumers:
 *   - Node identity: same `generateId(...)` helper, same qualified-name
 *     keyspace, same File/Folder/Method/Class node labels.
 *   - Edge vocabulary: `'import-resolved' | 'global' | 'local-call' |
 *     'same-file' | 'interface-dispatch' | 'read' | 'write'` — both
 *     paths emit the same reasons (see
 *     `gitnexus/src/core/ingestion/call-processor.ts` for the legacy
 *     emitter and `passes/receiver-bound-calls.ts` /
 *     `passes/free-call-fallback.ts` for the scope-resolution emitters).
 *   - Overload disambiguation: both paths use
 *     `generateId('Method', ...)` suffixed with `parameterTypes` when a
 *     method has overloads — see `graph-bridge/ids.ts`.
 *
 * The CI parity workflow (`.github/workflows/ci-scope-parity.yml`)
 * runs both paths on every migrated language's fixture corpus and
 * fails if the graph outputs diverge.
 *
 * Plan that introduced most of these invariants:
 * `docs/plans/2026-04-20-001-refactor-emit-pipeline-generalization-plan.md`.
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
import { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';

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
   *
   * `resolutionConfig` is the opaque value returned by
   * `loadResolutionConfig` (loaded once per workspace pass by the
   * orchestrator). TypeScript uses this to thread `tsconfig.json` path
   * aliases through to the standard resolver. Languages that don't
   * need any extra config ignore the parameter.
   */
  resolveImportTarget(
    targetRaw: string,
    fromFile: string,
    allFilePaths: ReadonlySet<string>,
    resolutionConfig?: unknown,
  ): string | readonly string[] | null;

  /**
   * Enumerate names visible through a wildcard import after the target
   * module scope has been linked. Languages that do not support
   * wildcard-style imports leave this undefined.
   */
  readonly expandsWildcardTo?: (
    targetModuleScope: ScopeId,
    parsedFiles: readonly ParsedFile[],
  ) => readonly string[];

  /**
   * Optional one-shot loader for cross-file import-resolution config
   * (e.g. tsconfig path aliases for TypeScript, go.mod paths for Go,
   * composer.json autoload for PHP). The orchestrator calls this once
   * per workspace pass with the repo root and threads the result into
   * every subsequent `resolveImportTarget` call as the
   * `resolutionConfig` parameter.
   *
   * Languages that don't need any per-workspace config leave this
   * undefined; the orchestrator threads `undefined` to
   * `resolveImportTarget` in that case. Returning `null` is also
   * supported and equivalent to "no config available".
   *
   * May be sync or async — the orchestrator awaits the result. The
   * shape is opaque to the orchestrator (`unknown`); the per-language
   * `resolveImportTarget` casts it to the language's expected shape.
   */
  loadResolutionConfig?(repoPath: string): Promise<unknown> | unknown;

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
   * Optional parallel MRO that EXCLUDES mixin-like augmentation (e.g., PHP
   * traits). Returns the inheritance-only ancestor chain — the same kind
   * of map as `buildMro` but built only from inheritance edges (EXTENDS).
   *
   * Used by the shared super-branch dispatch in `receiver-bound-calls`
   * so that `parent::method()` walks the inheritance chain only, not the
   * trait-augmented one. PHP semantics: `parent::` explicitly bypasses
   * traits, even when a composed trait shadows a same-named parent method.
   *
   * Languages without mixin-like semantics leave this undefined — callers
   * fall back to `buildMro`/`mroFor`, which for those languages is already
   * the inheritance chain.
   */
  readonly buildExtendsOnlyMro?: (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
  ) => Map<string /* DefId */, string[] /* ancestor DefIds */>;

  /**
   * Mutate `parsed.localDefs[i].ownerId` to point at the structural
   * owner. Python's rule: methods (Function defs whose parent scope
   * is Class) AND class-body fields (defs in Class scopes) are owned
   * by the enclosing class. Other languages may have richer rules
   * (e.g., Java inner-class qualification).
   */
  populateOwners(parsed: ParsedFile): void;

  /**
   * Optional workspace-wide ownership reconciliation for languages whose
   * member owner can be declared in a different file from the owner type.
   * Runs after every file has had `populateOwners(parsed)` applied, but
   * still before `reconcileOwnership`, so stamped ownerIds are copied into
   * the semantic model registries.
   */
  readonly populateWorkspaceOwners?: (
    parsedFiles: readonly ParsedFile[],
    ctx: { readonly fileContents: ReadonlyMap<string, string> },
  ) => void;

  /**
   * Recognize a `super(...)`-style receiver text. Python returns
   * `/^super\s*\(/.test(t)`. Java returns `t === 'super'`. C++ may
   * also need `this` capture. Languages without inheritance return
   * constant `false`.
   *
   * For languages where the answer depends on caller context (e.g.
   * C++, where `Base::method()` is a super call ONLY when `Base` is
   * actually a base of the caller's enclosing class, and namespace-
   * qualified calls like `Singleton::getInstance()` must NOT be
   * misclassified), implement the optional `isSuperReceiverInContext`
   * variant below. The receiver-bound-calls pass prefers the context-
   * aware variant when both are defined.
   */
  isSuperReceiver(receiverText: string): boolean;

  /**
   * Optional context-aware variant of `isSuperReceiver`. When defined,
   * the receiver-bound-calls pass prefers this hook over the simple
   * `isSuperReceiver(text)` form. Languages where super classification
   * is purely text-driven (Python, Java, PHP) omit this hook and the
   * simple form is used unchanged.
   *
   * C++ uses this to distinguish `Base::method()` (super call when
   * `Base` is in the caller's MRO) from `Singleton::getInstance()`
   * (ordinary namespace-qualified call). Without this, the regex
   * heuristic `/^[A-Z]\w*::/` misclassifies any uppercase-qualified
   * call as a super-receiver call and routes it through the wrong
   * resolution branch.
   *
   * Returns `true` ONLY when:
   *   - the receiver text parses as `<Name>::<...>` (or another super-
   *     form the language recognizes), AND
   *   - `<Name>` resolves (via scope chain) to a class-like def, AND
   *   - that class is in the MRO of the caller's enclosing class.
   *
   * Returns `false` for namespace-qualified calls, unresolved names,
   * class-qualified calls where the class is NOT in the caller's MRO,
   * and any text the simple `isSuperReceiver` hook also rejects.
   */
  readonly isSuperReceiverInContext?: (
    receiverText: string,
    callerScope: ScopeId,
    scopes: ScopeResolutionIndexes,
  ) => boolean;

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

  /**
   * Unwrap a property-style collection accessor on a typed receiver
   * to its element type. Called by `resolveCompoundReceiverClass`
   * when walking dotted member-access chains of the form
   * `receiver.Accessor`. The provider returns the element type's
   * simple name, or `undefined` when the accessor doesn't unwrap —
   * in which case the regular field-walk resumes.
   *
   * Use this only for languages that expose collection views as
   * properties rather than method calls; languages whose collection
   * views are `.values()` / `.keys()` method calls leave this
   * undefined and let the normal call-expression branch handle them.
   */
  readonly unwrapCollectionAccessor?: (
    receiverType: string,
    accessor: string,
  ) => string | undefined;

  /**
   * Collapse member-call CALLS edges by `(caller, target)` rather
   * than per-site. Default `false` — scope-resolution's contract
   * invariant is per-site dedup.
   *
   * Enable this when the language's graph convention is one edge per
   * caller/target pair regardless of how many syntactic sites exist,
   * e.g. to match a legacy graph's edge count so downstream
   * consumers don't see a migration-induced inflation.
   */
  readonly collapseMemberCallsByCallerTarget?: boolean;

  /**
   * Allow free-call emission to fall back to a unique workspace-wide
   * callable match when lexical/import bindings miss. Kept opt-in
   * because this mirrors legacy resolver behavior for some languages
   * but is too loose as a default for strict module systems.
   */
  readonly allowGlobalFreeCallFallback?: boolean;

  /**
   * Optional predicate to identify definitions with file-local linkage
   * (e.g. C `static` functions). When provided, `pickUniqueGlobalCallable`
   * excludes defs where `isFileLocalDef(def) === true` and the def lives
   * in a different file from the caller. This prevents the global free-call
   * fallback from creating CALLS edges to file-local symbols that are
   * logically invisible from the caller's translation unit.
   *
   * Languages without file-local linkage semantics leave this undefined.
   */
  readonly isFileLocalDef?: (def: SymbolDefinition) => boolean;

  /**
   * Optional predicate to gate free-call fallback emission by caller-side
   * visibility. When provided, `pickUniqueGlobalCallable` rejects candidates
   * the caller cannot legally reach — e.g., a PHP function in a different
   * namespace with no `use function` import, which PHP runtime would treat
   * as `Call to undefined function`. Returning `false` blocks the candidate;
   * returning `true` allows it; undefined-default keeps current behavior
   * (no visibility filtering, equivalent to "all candidates visible").
   *
   * The hook receives the caller's `ParsedFile` (so it can consult
   * `parsedImports`, `moduleScope`, etc.) and the candidate `SymbolDefinition`.
   * The predicate must be pure: same inputs → same answer.
   *
   * Languages without namespace-scoped function resolution leave this undefined.
   */
  readonly isCallableVisibleFromCaller?: (ctx: {
    readonly callerParsed: ParsedFile;
    readonly candidate: SymbolDefinition;
    /** Caller's enclosing scope id. Languages that gate visibility on
     *  caller scope (e.g. C++ two-phase template lookup) consult it;
     *  others ignore. Optional so existing implementations stay valid. */
    readonly callerScope?: ScopeId;
    /** ScopeResolutionIndexes for scope-tree walks. Optional for the
     *  same reason as `callerScope`. */
    readonly scopes?: ScopeResolutionIndexes;
  }) => boolean;

  /**
   * Optional argument-dependent-lookup (ADL / Koenig lookup) hook for
   * languages with C++-style associated-namespace candidate addition.
   *
   * Runs in the free-call fallback alongside ordinary unqualified lookup.
   * The fallback merges ordinary candidates with ADL candidates and applies
   * overload narrowing over the union.
   *
   * The hook inspects the call site's argument types, computes the
   * associated namespace set, and returns either:
   *   - an array of candidate `SymbolDefinition`s to add to the
   *     ordinary-lookup candidate pool.
   *   - `undefined` when ADL contributes no candidates.
   *
   * Languages without C++-style ADL leave this undefined. The
   * cross-language contract is "additive tier" — defining the hook never
   * removes candidates the prior tier would have produced.
   */
  readonly resolveAdlCandidates?: (
    site: {
      readonly name: string;
      readonly arity?: number;
      readonly argumentTypes?: readonly string[];
      readonly atRange: { readonly startLine: number; readonly startCol: number };
    },
    callerParsed: ParsedFile,
    scopes: ScopeResolutionIndexes,
    parsedFiles: readonly ParsedFile[],
  ) => readonly SymbolDefinition[] | undefined;

  /**
   * Optional resolver for qualified-receiver member calls where the
   * receiver is a namespace (not a class) and ordinary scope-chain /
   * import resolution doesn't find the member. C++ uses this for
   * `outer::foo()` style calls and to walk through inline-namespace
   * children transitively (`outer::v1::foo` reachable as `outer::foo`).
   *
   * Languages whose qualified-name semantics are already covered by the
   * receiver-bound-calls Case-1 namespace-targets path (e.g., Python's
   * `import X; X.foo()`) leave this undefined.
   *
   * Receiver-bound-calls invokes this hook AFTER Case 1 (namespace
   * imports) and AFTER Case 2 (class-name receiver) fail to resolve.
   * Returns the target def, `'ambiguous'` when multiple inline-namespace
   * children declare the same name (suppresses edge emission), or
   * `undefined` to fall through to the remaining cases.
   */
  readonly resolveQualifiedReceiverMember?: (
    receiverName: string,
    memberName: string,
    callerScope: ScopeId,
    scopes: ScopeResolutionIndexes,
    parsedFiles: readonly ParsedFile[],
  ) => SymbolDefinition | 'ambiguous' | undefined;

  /**
   * Enable the receiver-bound Case 0.5 fallback for explicit `this`
   * receivers (`this->m()` / `this.m()`) that resolves against the
   * enclosing class + MRO even when no explicit `this` typeBinding is
   * present in scope.
   *
   * Keep disabled for languages where the existing type-binding path
   * (Case 4) already handles `this` correctly and overload ambiguity
   * suppression must remain unchanged.
   */
  readonly resolveThisViaEnclosingClass?: boolean;

  /**
   * Optional post-finalize hook to inject cross-file bindings that
   * aren't modeled via explicit imports. Runs after
   * `buildWorkspaceResolutionIndex` and before
   * `propagateImportedReturnTypes`.
   *
   * Use this for languages where a compiler-implicit visibility rule
   * makes names visible across files without a syntactic import —
   * for example a shared-namespace convention where types declared
   * in the same namespace see each other without a `using` / `import`
   * statement. Languages that require explicit imports for cross-file
   * visibility leave this undefined.
   */
  readonly populateNamespaceSiblings?: (
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    ctx: {
      readonly fileContents: ReadonlyMap<string, string>;
      /** Pre-parsed tree-sitter trees keyed by file path. Same cache
       *  the orchestrator hands to `extractParsedFile`; passing it
       *  through here lets per-language hooks read the AST without
       *  triggering a second parse. Cache miss = the hook re-parses
       *  itself; the cache is opt-in for hooks that need AST-level
       *  facts beyond what `ParsedFile` exposes. */
      readonly treeCache?: { get(filePath: string): unknown };
    },
  ) => void;

  /**
   * Whether the compound-receiver resolver should walk up from a
   * class scope to ancestor (Module) scopes when looking up a
   * method's return-type typeBinding. Default `false`.
   *
   * Set `true` only when the provider stores method return-type
   * bindings on the enclosing Module scope rather than on the class
   * scope. Without this walk-up, chain resolution fails for methods
   * whose return types were hoisted to module scope.
   *
   * Providers that attach return-type bindings directly to the class
   * scope leave this undefined — enabling the walk-up for them would
   * add an unnecessary branch and risk picking up unrelated module-
   * level bindings.
   */
  readonly hoistTypeBindingsToModule?: boolean;

  /**
   * Optional: detect structural (duck-typing) interface implementations.
   * Languages like Go use structural typing — a struct satisfies an
   * interface if its method set is a superset, without an explicit
   * `implements` keyword. Runs after finalize, before resolution passes.
   * Returns: Map<interface_DefId, implementing_struct_DefId[]>.
   * Default: undefined (no structural interface detection).
   */
  readonly detectInterfaceImplementations?: (
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    model: SemanticModel,
  ) => Map<string, string[]>;

  /**
   * Optional: mirror typeBindings from namespace-import target modules
   * into the importer's module scope. Languages like Go use namespace
   * imports (`import "pkg"`) and need the target package's exported
   * typeBindings visible in the importer's scope chain for cross-package
   * return-type resolution (e.g. `x := pkg.NewUser(); x.Save()` needs
   * `NewUser → User` mirrored from the target package). Runs after
   * `populateNamespaceSiblings` and before `propagateImportedReturnTypes`
   * so the SCC-ordered pass sees the mirrored bindings.
   * Default: undefined (no namespace typeBinding mirroring).
   */
  readonly mirrorNamespaceTypeBindings?: (
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    workspaceIndex: import('../../scope-resolution/workspace-index.js').WorkspaceResolutionIndex,
  ) => void;

  /**
   * Optional: bind for-range loop variables to their element/value types.
   * Languages like Go need to resolve `for _, v := range m` where `m` is
   * `map[K]V` — the variable `v` should bind to `V`. Runs after finalize,
   * before resolution passes. Mutates scope typeBindings via the Map cast
   * convention (see Invariant I8).
   * Default: undefined (no range variable binding).
   */
  readonly populateRangeBindings?: (
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    ctx: {
      readonly fileContents: ReadonlyMap<string, string>;
      readonly treeCache?: { get(filePath: string): unknown };
    },
  ) => void;

  /**
   * Optional post-resolution pass: emit CALLS edges for member-call sites
   * whose receiver cannot be typed by the scope chain (no `TypeRef`).
   * Dynamically-typed languages with untyped/`mixed`/`Any` parameters use
   * this hook to recover the call edge via workspace-wide method-name
   * lookup, mirroring what their legacy resolvers did.
   *
   * Runs AFTER `emitReceiverBoundCalls` and BEFORE `emitFreeCallFallback`.
   * Implementations MUST:
   *   - Skip sites already in `handledSites` (Invariant I2).
   *   - Add resolved site keys to `handledSites` before returning.
   *   - Stay narrow: a unique workspace-wide match is the safe baseline.
   *     Multi-candidate fallbacks should narrow by arity / argument types
   *     before emitting to keep false-positive rate bounded.
   *
   * Returns the number of edges emitted (for telemetry).
   *
   * Default: undefined (no unresolved-receiver fallback).
   */
  readonly emitUnresolvedReceiverEdges?: (
    graph: KnowledgeGraph,
    scopes: ScopeResolutionIndexes,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    handledSites: Set<string>,
    model: SemanticModel,
  ) => number;
}
