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
  TypeRef,
} from 'gitnexus-shared';

export interface ScopeResolutionIndexes {
  readonly scopeTree: ScopeTree;
  readonly defs: DefIndex;
  readonly qualifiedNames: QualifiedNameIndex;
  readonly moduleScopes: ModuleScopeIndex;
  readonly methodDispatch: MethodDispatchIndex;
  /** Finalized `ImportEdge[]` per module scope. */
  readonly imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>;
  /** Finalize-output bindings (local + imports + wildcards) per module scope.
   *  Inner `BindingRef[]` arrays are frozen by `materializeBindings`;
   *  this channel is permanently immutable post-finalize. Consumers
   *  MUST read via `lookupBindingsAt` so the augmentation channel is
   *  consulted alongside. See I8 in `contract/scope-resolver.ts`. */
  readonly bindings: ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>;
  /** Append-only post-finalize augmentation channel. Populated by
   *  language hooks such as `populateNamespaceSiblings` for cross-file
   *  bindings synthesized after finalize (e.g. C# same-namespace
   *  visibility, `using static` member exposure). Inner arrays are
   *  NOT frozen — hooks `push()` directly. Walkers must consult both
   *  this map and `bindings` via `lookupBindingsAt`; finalized refs
   *  are returned first and win duplicate `def.nodeId` metadata, with
   *  unique augmentations appended after. See I8. */
  readonly bindingAugmentations: ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>;
  /** Workspace-level binding lookup, shared instead of per-scope
   *  duplication. Consulted by `lookupBindingsAt` as a third source after
   *  finalized and per-scope augmented bindings. Language-specific
   *  namespace-sibling hooks populate it with disjoint key formats that
   *  never collide — e.g. backslash-separated FQNs (`App\Models\User`) for
   *  backslash-namespace languages, and bare simple names (`User`) for
   *  global-/default-namespace types that are visible from every file. The
   *  shared map gives those workspace-wide names one entry each instead of
   *  O(scopes × defs) per-scope augmentation. */
  readonly workspaceFqnBindings: ReadonlyMap<string, readonly BindingRef[]>;
  /** Workspace-level *type* binding lookup — the typeBindings analogue of
   *  `workspaceFqnBindings`. Holds names that are type-visible from every file
   *  (e.g. C# global/default-namespace method return-type bindings, keyed by
   *  the bound name). The C# language spec makes the unnamed global namespace a
   *  single declaration space whose members are available from inside named
   *  namespaces too — so this channel is consulted scope-independently by the
   *  typeBindings chain-walkers (`findReceiverTypeBinding`,
   *  `followChainPostFinalize`) as a final fallback after the per-scope chain.
   *  Routing global types here gives them one shared entry instead of the
   *  O(scopes × defs) per-file `Scope.typeBindings` copy that OOM'd large
   *  no-namespace solutions (#1871) — mirroring how Roslyn resolves against a
   *  single `Compilation.GlobalNamespace` symbol rather than per-file copies.
   *  Populated post-finalize by `populateCsharpNamespaceSiblings`; most
   *  languages leave it empty. */
  readonly workspaceTypeBindings: ReadonlyMap<string, TypeRef>;
  /** Per-namespace class/def binding lookup — the namespace-scoped analogue of
   *  `workspaceFqnBindings`. Outer key is the namespace name (e.g. `App.Models`),
   *  inner key is the simple name. Unlike the flat workspace channels (which are
   *  visible from *every* file — correct only for the global/default namespace),
   *  named-namespace types are visible only within that namespace and to files
   *  that import it, so this channel is consulted through an accessibility gate
   *  (`accessibleNamespacesByScope`) rather than unconditionally. Routing named
   *  siblings here gives them one entry per def instead of the O(files × defs)
   *  per-scope augmentation that OOM'd large single-namespace solutions (#1871).
   *  Populated post-finalize by language namespace-sibling hooks; most languages
   *  leave it empty. */
  readonly namespaceFqnBindings: ReadonlyMap<string, ReadonlyMap<string, readonly BindingRef[]>>;
  /** Per-namespace *type* binding lookup — the namespace-scoped analogue of
   *  `workspaceTypeBindings`. Outer key is the namespace name, inner key is the
   *  bound name (e.g. a method name mapping to its return TypeRef). Consulted by
   *  the typeBindings chain-walkers (`findReceiverTypeBinding`,
   *  `followChainPostFinalize`) through the `accessibleNamespacesByScope` gate
   *  after the per-scope chain and the flat `workspaceTypeBindings` miss.
   *  Populated post-finalize; most languages leave it empty. */
  readonly namespaceTypeBindings: ReadonlyMap<string, ReadonlyMap<string, TypeRef>>;
  /** Accessibility gate for the per-namespace channels: maps a module ScopeId to
   *  the namespace names type-visible from that file — its own declared
   *  namespace(s) plus every imported/`using`d namespace (and dotted prefixes).
   *  This is the same per-file accessible-namespace set the C# hook already
   *  derives (`expandedNamespaces`), materialized so the language-neutral walkers
   *  can consult `namespaceFqnBindings` / `namespaceTypeBindings` for exactly the
   *  namespaces a file can see — preserving namespace visibility semantics
   *  without the per-file binding copy. Empty when no language populates the
   *  namespace channels. */
  readonly accessibleNamespacesByScope: ReadonlyMap<ScopeId, readonly string[]>;
  /** Pre-resolution usage facts; consumed by the resolution phase. */
  readonly referenceSites: readonly ReferenceSite[];
  /** SCC condensation of the file-level import graph — callers that want
   *  parallel per-SCC processing in the resolution phase read this. */
  readonly sccs: readonly FinalizedScc[];
  readonly stats: FinalizeStats;
}
