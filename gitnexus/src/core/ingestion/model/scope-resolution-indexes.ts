/**
 * `ScopeResolutionIndexes` — the bundle of materialized indexes produced
 * by the finalize-orchestrator (RFC #909 Ring 2 PKG #921) and attached
 * to `MutableSemanticModel`.
 *
 * Produced by `finalizeScopeModel(parsedFiles, hooks)` in
 * `finalize-orchestrator.ts`. Consumed by the resolution phase (future
 * tickets) where `Registry.lookup` / `resolveTypeRef` query this bundle
 * to answer call-resolution questions without re-walking any AST.
 *
 * ## Lifecycle
 *
 *   1. Pipeline collects `ParsedFile[]` from the parsing-processor (#920).
 *   2. Pipeline invokes `finalizeScopeModel(parsedFiles, hooks)` →
 *      returns a `ScopeResolutionIndexes` (this interface).
 *   3. Pipeline calls `model.attachScopeIndexes(indexes)` to stamp them
 *      onto the `MutableSemanticModel`. This is a **one-shot write**;
 *      subsequent calls throw. After attachment, the indexes are frozen
 *      at the type level (everything is `readonly`) and at runtime via
 *      `Object.freeze` on the bundle.
 *   4. Resolution callers hold a `SemanticModel` reference and read
 *      `model.scopes` to query.
 *
 * ## Content
 *
 *   - `scopeTree` / `moduleScopes` / `defs` / `qualifiedNames` — the
 *     four Ring 2 SHARED indexes built over per-file artifacts.
 *   - `methodDispatch` — MRO + implements materialized view (#914).
 *   - `imports` — finalized `ImportEdge[]` per module scope (`parsedImports`
 *     resolved through cross-file link + wildcard expansion).
 *   - `bindings` — merged bindings per module scope (local + import +
 *     wildcard + re-export), with the provider's precedence applied.
 *   - `referenceSites` — union of every file's pre-resolution usage
 *     facts. Consumed by the resolution phase (future) to emit
 *     `Reference` records into `ReferenceIndex`.
 *   - `stats` — coarse-grained counts from the shared finalize algorithm
 *     (total files/edges, linked vs unresolved, SCC topology).
 *
 * `ReferenceIndex` is deliberately NOT here — it is populated in a later
 * phase (RFC §3.2 Phase 4 / Ring 2 PKG #925) and owned separately.
 */

import type {
  BindingRef,
  DefIndex,
  FinalizedScc,
  FinalizeStats,
  ImportEdge,
  MethodDispatchIndex,
  ModuleScopeIndex,
  QualifiedNameIndex,
  ReferenceSite,
  ScopeId,
  ScopeTree,
} from 'gitnexus-shared';

export interface ScopeResolutionIndexes {
  readonly scopeTree: ScopeTree;
  readonly defs: DefIndex;
  readonly qualifiedNames: QualifiedNameIndex;
  readonly moduleScopes: ModuleScopeIndex;
  readonly methodDispatch: MethodDispatchIndex;
  /** Finalized `ImportEdge[]` per module scope. */
  readonly imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>;
  /** Merged bindings (local + imports + wildcards) per module scope. */
  readonly bindings: ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>;
  /** Pre-resolution usage facts; consumed by the resolution phase. */
  readonly referenceSites: readonly ReferenceSite[];
  /** SCC condensation of the file-level import graph — callers that want
   *  parallel per-SCC processing in the resolution phase read this. */
  readonly sccs: readonly FinalizedScc[];
  readonly stats: FinalizeStats;
}
