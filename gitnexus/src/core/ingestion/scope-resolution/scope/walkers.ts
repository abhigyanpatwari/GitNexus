/**
 * Scope-chain lookup primitives shared across language providers.
 *
 * Five functions:
 *   - `findReceiverTypeBinding` — walk scope.typeBindings up the chain
 *     for a receiver name.
 *   - `lookupBindingsAt` — read finalized + augmented binding refs at
 *     one scope, deduped by `def.nodeId`. The dual-source-aware
 *     primitive every other binding lookup composes with.
 *   - `findClassBindingInScope` — walk scope.bindings + the indexes via
 *     `lookupBindingsAt` for a class-kind binding.
 *   - `findOwnedMember` — find a method/field owned by a class def
 *     across all parsed files by (ownerId, simpleName).
 *   - `findExportedDef` — find a file-level exported def (top-of-module
 *     class / function) by simpleName.
 *
 * Next-consumer contract: every OO or module-capable language hits the
 * same pre-finalize / post-finalize binding split and the same
 * "resolve member on owner with MRO" pattern. All four are reusable
 * as-is for TypeScript, Java, Kotlin, Ruby, etc.
 */

import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';

const EMPTY_BINDINGS: readonly BindingRef[] = Object.freeze([]);

/**
 * Look up binding refs at `scopeId` for `name`, consulting both the
 * finalize-owned `bindings` channel and the post-finalize
 * `bindingAugmentations` channel (see invariant I8 in
 * `contract/scope-resolver.ts`). Finalized refs come first; augmented
 * refs append, deduped by `def.nodeId` so a sibling that's also
 * explicitly imported doesn't double-emit.
 *
 * Returns a shared frozen empty array when neither channel has the
 * name — callers can compare against `=== EMPTY_BINDINGS` if they
 * want a fast-path miss check. The bucket arrays are returned by
 * reference when only one channel populates them; the merged path
 * allocates a fresh array.
 *
 * Walker primitives (`findClassBindingInScope`,
 * `findCallableBindingInScope`, `findExportedDefByName`) and
 * post-finalize passes that read finalized bindings (e.g.
 * `propagateImportedReturnTypes`, `namespace-targets`) MUST go
 * through this helper instead of `scopes.bindings.get(...)` directly,
 * so the augmentation channel is always visible.
 */
export function lookupBindingsAt(
  scopeId: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly BindingRef[] {
  const finalized = scopes.bindings.get(scopeId)?.get(name);
  const augmented = scopes.bindingAugmentations.get(scopeId)?.get(name);
  const workspace = scopes.workspaceFqnBindings?.get(name);
  // Per-namespace channel (#1871 named-namespace generalization). Gated by
  // accessibility: only a *module* scope carries an `accessibleNamespacesByScope`
  // entry, so this collects nothing at child scopes and at module scopes only for
  // the namespaces that file can see. Empty (no entry) for every non-C# bundle,
  // so the behavior of the three pre-existing channels is unchanged.
  const namespaceRefs = collectNamespaceFqnBindings(scopeId, name, scopes);
  const fLen = finalized?.length ?? 0;
  const aLen = augmented?.length ?? 0;
  const wLen = workspace?.length ?? 0;
  const nLen = namespaceRefs?.length ?? 0;
  if (fLen === 0 && aLen === 0 && wLen === 0 && nLen === 0) return EMPTY_BINDINGS;
  if (aLen === 0 && wLen === 0 && nLen === 0) return finalized!;
  if (fLen === 0 && wLen === 0 && nLen === 0) return augmented!;
  if (fLen === 0 && aLen === 0 && nLen === 0) return workspace!;
  if (fLen === 0 && aLen === 0 && wLen === 0) return namespaceRefs!;
  // Merge in precedence order, deduped by `def.nodeId` so the strongest source
  // wins duplicate metadata. Named-namespace refs come BEFORE the flat global
  // `workspace` channel: pre-#1871 these lived in `bindingAugmentations` (which
  // `lookupBindingsAt` already ranks above `workspaceFqnBindings`), so a name in
  // both an accessible named namespace and the global namespace must still
  // resolve named-first. Order: finalized > augmented > namespace > workspace.
  const seen = new Set<string>();
  const out: BindingRef[] = [];
  for (const src of [finalized, augmented, namespaceRefs, workspace]) {
    if (src === undefined) continue;
    for (const r of src) {
      if (seen.has(r.def.nodeId)) continue;
      seen.add(r.def.nodeId);
      out.push(r);
    }
  }
  return out;
}

/**
 * Collect `BindingRef`s for `name` from the per-namespace channel
 * (`namespaceFqnBindings`) across every namespace accessible from `scopeId`.
 * Accessibility comes from `accessibleNamespacesByScope`, which is keyed by
 * *module* scope id — so this returns `undefined` at non-module scopes and at
 * every scope in a bundle that didn't populate the channel (all non-C# today).
 * Language-neutral: keyed only by namespace strings and the index.
 */
function collectNamespaceFqnBindings(
  scopeId: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly BindingRef[] | undefined {
  const namespaces = scopes.accessibleNamespacesByScope?.get(scopeId);
  if (namespaces === undefined || namespaces.length === 0) return undefined;
  let collected: BindingRef[] | undefined;
  for (const ns of namespaces) {
    const bucket = scopes.namespaceFqnBindings?.get(ns)?.get(name);
    if (bucket !== undefined && bucket.length > 0) {
      if (collected === undefined) collected = [];
      for (const r of bucket) collected.push(r);
    }
  }
  return collected;
}

const EMPTY_NAMES: Iterable<string> = Object.freeze([]) as readonly string[];

/**
 * Return the union of bound names at `scopeId` across both the
 * finalized and augmented channels. Companion to `lookupBindingsAt`
 * for callers that need to iterate every name at a scope (e.g.
 * `propagateImportedReturnTypes`). Order is not guaranteed; callers
 * that need stable iteration should sort externally.
 *
 * Fast paths (zero allocation) when at most one channel is populated:
 * returns the underlying `Map.keys()` iterator directly. Only when both
 * channels carry names do we materialize a `Set` for deduplication.
 *
 * Scope: enumerates only the per-scope `bindings` and `bindingAugmentations`
 * channels. It deliberately EXCLUDES the scope-independent
 * `workspaceFqnBindings` channel (PHP FQN keys, C# global-namespace simple
 * names). `lookupBindingsAt` consults that third channel when resolving a
 * specific name, but name *enumeration* here does not — those names apply at
 * every scope and would flood per-scope callers. Callers that need
 * workspace-level names must read `workspaceFqnBindings` directly.
 */
export function namesAtScope(scopeId: ScopeId, scopes: ScopeResolutionIndexes): Iterable<string> {
  const finalized = scopes.bindings.get(scopeId);
  const augmented = scopes.bindingAugmentations.get(scopeId);
  const fSize = finalized?.size ?? 0;
  const aSize = augmented?.size ?? 0;
  if (fSize === 0 && aSize === 0) return EMPTY_NAMES;
  if (aSize === 0) return finalized!.keys();
  if (fSize === 0) return augmented!.keys();
  const out = new Set<string>(finalized!.keys());
  for (const name of augmented!.keys()) out.add(name);
  return out;
}

/**
 * True when a def's `type` names a class-like declaration — every kind
 * that collapses to `@scope.class` in the scope-extractor query contract.
 *
 * Semantics widened historically from `'Class' | 'Interface'` to cover
 * C#-shape languages (struct, record, enum, trait). Languages that emit
 * only `'Class'` are unaffected — the extra kinds never appear in their
 * parsed output.
 */
export function isClassLike(t: string): boolean {
  return (
    t === 'Class' ||
    t === 'Interface' ||
    t === 'Struct' ||
    t === 'Record' ||
    t === 'Enum' ||
    t === 'Trait'
  );
}

/**
 * Walk the scope chain from `startScope` looking for a typeBinding
 * named `receiverName`. Returns the TypeRef or undefined if no binding
 * exists in the chain.
 */
export function findReceiverTypeBinding(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  let moduleScopeId: ScopeId | null = null;
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    const typeRef = scope.typeBindings.get(receiverName);
    if (typeRef !== undefined) return typeRef;
    if (scope.kind === 'Module') moduleScopeId = currentId;
    currentId = scope.parent;
  }
  // Fallback 1 — named namespaces accessible from this file (own + `using`d),
  // gated by `accessibleNamespacesByScope`. Consulted BEFORE the global channel
  // so a more-specific named binding wins, matching the pre-#1871 order where
  // these lived in the file's own `Scope.typeBindings` (the chain, above the
  // global fallback). Shared-channel routing avoids the O(files × names) blow-up.
  const named = namespaceTypeBindingFor(moduleScopeId, receiverName, scopes);
  if (named !== undefined) return named;
  // Fallback 2 — global/default namespace: C# global types are visible from
  // every file (see `workspaceTypeBindings` doc), so this flat channel is the
  // final, unconditional fallback (#1871).
  return scopes.workspaceTypeBindings?.get(receiverName);
}

/**
 * Resolve a typeBinding for `name` from the per-namespace channel
 * (`namespaceTypeBindings`) across the namespaces accessible from `moduleScopeId`.
 * First accessible-namespace hit wins. Returns `undefined` when the module has no
 * accessibility entry (non-module scope id, or a bundle that didn't populate the
 * channel — all non-C# today). Shared by the two typeBindings chain-walkers so
 * the named-namespace fallback stays identical between them.
 */
export function namespaceTypeBindingFor(
  moduleScopeId: ScopeId | null,
  name: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  if (moduleScopeId === null) return undefined;
  const namespaces = scopes.accessibleNamespacesByScope?.get(moduleScopeId);
  if (namespaces === undefined) return undefined;
  for (const ns of namespaces) {
    const hit = scopes.namespaceTypeBindings?.get(ns)?.get(name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Walk the scope chain from `startScope` to its enclosing Module scope id, or
 * `null` if none is found. Used by chain-followers that need the module scope to
 * consult the accessibility-gated per-namespace channels.
 */
export function moduleScopeIdOf(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): ScopeId | null {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return null;
    if (scope.kind === 'Module') return currentId;
    currentId = scope.parent;
  }
  return null;
}

/**
 * Look up a class-like binding by name in the given scope's chain.
 *
 * "Class-like" covers `Class | Interface | Struct | Record | Enum |
 * Trait` via the shared `isClassLike` predicate — every kind that
 * collapses to `@scope.class` in the scope-extractor query contract.
 *
 * Walks the scope chain upward and consults TWO sources at each step:
 *   1. `scope.bindings` — populated during scope-extraction Pass 2 with
 *      local declarations (`origin: 'local'`).
 *   2. The cross-file finalized + augmented bindings, via
 *      `lookupBindingsAt` (per I8: finalized = canonical immutable
 *      output; augmented = post-finalize hooks like
 *      `populateNamespaceSiblings`).
 *
 * Without (2) we'd miss every cross-file class-receiver call.
 */
export function findClassBindingInScope(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  const local = walkScopeChain(startScope, receiverName, scopes, (def) => isClassLike(def.type));
  if (local !== undefined) return local;

  // Fallback for languages (Go) where namespace-style imports don't
  // create scope bindings: resolve via QualifiedNameIndex. Only fires
  // when the scope-chain walk found nothing; single-match wins.
  const qnames = scopes.qualifiedNames.get(receiverName);
  if (qnames.length === 1) {
    const def = scopes.defs.get(qnames[0]!);
    if (def !== undefined && isClassLike(def.type)) return def;
  }
  // Second fallback: dotted names like "models.User" — try the simple
  // name (tail after last dot) for languages where defs are indexed by
  // simple name (Go). Only when the dotted lookup fails.
  if (receiverName.includes('.')) {
    const simple = receiverName.slice(receiverName.lastIndexOf('.') + 1);
    if (simple.length > 0 && simple !== receiverName) {
      const simpleIds = scopes.qualifiedNames.get(simple);
      if (simpleIds.length === 1) {
        const def = scopes.defs.get(simpleIds[0]!);
        if (def !== undefined && isClassLike(def.type)) return def;
      }
    }
  }
  return undefined;
}

/**
 * Import/include-aware disambiguation for an *ambiguous* class-like base
 * name. Engages ONLY as a fallback after `findClassBindingInScope` has
 * already returned `undefined` — i.e. the scope-chain walk and the
 * single-match `qualifiedNames` fast paths could not pick a winner because
 * several same-named class-like defs exist (e.g. two `class Handler`s in
 * different headers/namespaces).
 *
 * Disambiguates by the referencing file's import graph: the enclosing
 * module scope's finalized `ImportEdge[]` (C++ `#include`, C# `using`, etc.)
 * each carry the exporting file in `targetFile`. A candidate whose defining
 * file is brought in by one of those edges is preferred. Resolution is
 * tiered, strictest first, and only commits when EXACTLY ONE candidate
 * survives a tier — so a still-ambiguous name keeps the historical
 * "return undefined" refusal:
 *
 *   1. Exact file match — candidate.filePath === an import's `targetFile`
 *      (covers C++ `#include "handler_a.h"` → that header's class).
 *   2. Same-directory match — candidate.filePath sits in the same directory
 *      as some import target file (covers C# `using MyApp.Models;`, where the
 *      namespace import resolves to ONE representative file in the namespace's
 *      directory, not necessarily the file declaring the referenced type).
 *
 * Language-neutral: keyed only on the finalized import edges and the
 * candidate defs' `filePath`. Returns `undefined` (preserving refusal) when
 * the name is single-match-resolvable already (never reached — caller gates
 * on `findClassBindingInScope` miss), when no import disambiguates, or when
 * a tier leaves more than one survivor.
 */
export function resolveAmbiguousInheritanceBaseViaImports(
  startScope: ScopeId,
  baseName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  // Gather the class-like candidates that share this simple name. Defs are
  // indexed by their `qualifiedName` in `qualifiedNames`; for languages whose
  // class qualifiedName IS the simple name (C++, C#, etc.) this is the full
  // candidate set. A single candidate is not "ambiguous" — leave it to the
  // existing single-match fast path (this fallback shouldn't have been called).
  const candidateIds = scopes.qualifiedNames.get(baseName);
  if (candidateIds.length < 2) return undefined;
  const candidates: SymbolDefinition[] = [];
  for (const id of candidateIds) {
    const def = scopes.defs.get(id);
    if (def !== undefined && isClassLike(def.type)) candidates.push(def);
  }
  if (candidates.length < 2) return undefined;

  // Collect the exporting files imported by the referencing file's enclosing
  // module scope (the chain may carry function-local imports too, but the
  // module scope is where `#include` / `using` land).
  const moduleScopeId = moduleScopeIdOf(startScope, scopes);
  if (moduleScopeId === null) return undefined;
  const importEdges = scopes.imports.get(moduleScopeId);
  if (importEdges === undefined || importEdges.length === 0) return undefined;
  const importedFiles = new Set<string>();
  const importedDirs = new Set<string>();
  for (const edge of importEdges) {
    if (edge.targetFile === null) continue;
    importedFiles.add(edge.targetFile);
    importedDirs.add(dirnameOf(edge.targetFile));
  }
  if (importedFiles.size === 0) return undefined;

  // Tier 1 — exact file match (C++ `#include "handler_a.h"`).
  const exact = candidates.filter((c) => importedFiles.has(c.filePath));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined; // still ambiguous → refuse

  // Tier 2 — same-directory match (C# namespace `using`, where the namespace
  // import resolves to one representative file in the namespace's directory).
  const sameDir = candidates.filter((c) => importedDirs.has(dirnameOf(c.filePath)));
  if (sameDir.length === 1) return sameDir[0];

  return undefined;
}

/**
 * Directory portion of a forward-slash workspace-relative path. Returns `''`
 * for a bare filename (no directory). Workspace paths are always normalized to
 * `/` separators upstream, so a simple `lastIndexOf('/')` is sufficient and
 * keeps this dependency-free.
 */
function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

/**
 * Predicate for value-receiver bridge: the labels for which
 * `reconcileOwnership` registers methods/fields under the def's
 * `nodeId` as the `ownerId`. Explicit allowlist so future NodeLabel
 * additions (Module, Namespace, TypeAlias, EnumMember, etc.) do NOT
 * silently widen the bridge — adding a new ownerable label requires
 * touching both this predicate and `reconcileOwnership`.
 *
 * See: `scope-resolution/pipeline/reconcile-ownership.ts` Property /
 * Variable / Const / Static registration block.
 */
export function isOwnableValueLabel(t: string): boolean {
  return t === 'Const' || t === 'Variable' || t === 'Property' || t === 'Static';
}

/**
 * Look up a value-binding (Const/Variable/Property/Static) by name in
 * the given scope's chain. Used by the value-receiver-owner bridge
 * for object-literal services such as:
 *
 *   export const fooService = { getUser(id) {...} };
 *
 * where `fooService` is a `Const`/`Variable` whose `nodeId` is the
 * `ownerId` of the member method. Neither `findClassBindingInScope`
 * (rejects non-class-like) nor `findReceiverTypeBinding` (no typeBinding
 * for an unannotated literal) finds it.
 *
 * Mirrors `findClassBindingInScope` exactly; only the accepted def-type
 * predicate differs.
 */
export function findValueBindingInScope(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  return walkScopeChain(startScope, receiverName, scopes, (def) => isOwnableValueLabel(def.type));
}

/**
 * Generic scope-chain walker. Walks from `startScope` toward the root,
 * consulting both the local `scope.bindings` channel and the dual-source
 * `lookupBindingsAt` view (finalized + augmented). At each scope, local
 * bindings are exhausted BEFORE imported/augmented bindings — preserves
 * JavaScript-style lexical scoping where a local `const x` shadows an
 * imported `x` of the same name.
 *
 * Returns the first binding `def` matching `predicate`. Cycles in the
 * scope graph terminate the walk (defensive — should not occur in
 * well-formed inputs).
 */
function walkScopeChain(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
  predicate: (def: SymbolDefinition) => boolean,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;

    // Local first: a `const x` in this scope shadows any imported `x`.
    const localBindings = scope.bindings.get(name);
    if (localBindings !== undefined) {
      for (const b of localBindings) {
        if (predicate(b.def)) return b.def;
      }
    }

    // Then imported/augmented bindings — only consulted when no local match.
    const importedBindings = lookupBindingsAt(currentId, name, scopes);
    for (const b of importedBindings) {
      if (predicate(b.def)) return b.def;
    }

    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Look up a callable (Function/Method/Constructor) by name in the
 * given scope's chain. Uses the dual-source pattern (scope.bindings +
 * `lookupBindingsAt` for finalized + augmented) so cross-file
 * imports are visible — without it free calls to imported functions
 * never resolve via the post-pass.
 *
 * Mirrors `findClassBindingInScope` exactly; only the accepted
 * def-type predicate differs.
 */
export function findCallableBindingInScope(
  startScope: ScopeId,
  callableName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  return findAllCallableBindingsInScope(startScope, callableName, scopes)[0];
}

/**
 * Look up all callable bindings (Function/Method/Constructor) by name
 * from the nearest scope in the chain that binds `callableName`.
 *
 * Preserves the original scope-walk boundary used by
 * `findCallableBindingInScope`: once any callable binding is found in a
 * scope, outer scopes are not consulted.
 */
export function findAllCallableBindingsInScope(
  startScope: ScopeId,
  callableName: string,
  scopes: ScopeResolutionIndexes,
): readonly SymbolDefinition[] {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return [];
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return [];

    const out: SymbolDefinition[] = [];
    const seen = new Set<string>();
    const pushCallable = (def: SymbolDefinition): void => {
      if (def.type !== 'Function' && def.type !== 'Method' && def.type !== 'Constructor') return;
      if (seen.has(def.nodeId)) return;
      seen.add(def.nodeId);
      out.push(def);
    };

    const localBindings = scope.bindings.get(callableName);
    if (localBindings !== undefined) {
      for (const b of localBindings) {
        pushCallable(b.def);
      }
    }

    const importedBindings = lookupBindingsAt(currentId, callableName, scopes);
    for (const b of importedBindings) {
      pushCallable(b.def);
    }

    if (out.length > 0) return out;
    currentId = scope.parent;
  }
  return [];
}

/**
 * ISO C++ `[basic.lookup.unqual]` §7: ADL is suppressed when ordinary
 * unqualified lookup finds:
 *   - a name that is NOT a function or function template, OR
 *   - a block-scope function declaration that is NOT a using-declaration.
 *
 * Combined walker that stops at the **nearest scope** where `name` has any
 * binding (callable or non-callable) and returns:
 *   - `callables`: Function/Method/Constructor defs found at that scope
 *   - `nonCallableFound`: a non-function binding was present (variable, class, etc.)
 *   - `blockScopeDeclFound`: a callable was found at a Function or Block scope
 *     (block-scope function declaration that blocks ADL)
 *
 * One pass, one stop — no divergence between callable collection and blocker
 * detection.
 */
export function findCallableBindingsAndAdlBlocker(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): {
  callables: readonly SymbolDefinition[];
  nonCallableFound: boolean;
  blockScopeDeclFound: boolean;
} {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId))
      return { callables: [], nonCallableFound: false, blockScopeDeclFound: false };
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined)
      return { callables: [], nonCallableFound: false, blockScopeDeclFound: false };

    const callables: SymbolDefinition[] = [];
    const seen = new Set<string>();
    let nonCallableFound = false;
    let anyBinding = false;

    const process = (def: SymbolDefinition): void => {
      anyBinding = true;
      if (def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor') {
        if (!seen.has(def.nodeId)) {
          seen.add(def.nodeId);
          callables.push(def);
        }
      } else {
        nonCallableFound = true;
      }
    };

    const localBindings = scope.bindings.get(name);
    if (localBindings !== undefined) {
      for (const b of localBindings) {
        process(b.def);
      }
    }

    const importedBindings = lookupBindingsAt(currentId, name, scopes);
    for (const b of importedBindings) {
      process(b.def);
    }

    if (anyBinding) {
      // ISO C++: a block-scope function declaration (Function or Block scope)
      // that is NOT a using-declaration blocks ADL. If we found callables at
      // a function/block scope, ADL must be suppressed.
      const blockScopeDeclFound =
        callables.length > 0 && (scope.kind === 'Function' || scope.kind === 'Block');
      return { callables, nonCallableFound, blockScopeDeclFound };
    }
    currentId = scope.parent;
  }
  return { callables: [], nonCallableFound: false, blockScopeDeclFound: false };
}

/**
 * Populate `ownerId` on every def structurally owned by a Class
 * scope — methods (defs in Function scopes whose parent is Class)
 * and class-body fields (defs directly in Class scopes).
 *
 * Generic OO ownership rule. Languages that want richer ownership
 * (e.g. inner-class qualification) can compose with this as a base
 * step.
 *
 * Mutates `parsed.localDefs` in place via type cast — `SymbolDefinition`
 * is `readonly` for consumers but the extractor returns plain objects.
 * Defs are shared by reference between `localDefs` and `Scope.ownedDefs`,
 * so this single mutation is visible from both sides.
 */
export function populateClassOwnedMembers(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, ParsedFile['scopes'][number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  // Promote a def's qualifiedName from `methodName` to `ClassName.methodName`
  // when the def sits inside a class. Without this, two classes in the
  // same file that share a method name collide at the graph-bridge lookup
  // (`node-lookup.ts` keys by (filePath, qualifiedName) and falls back to
  // simple name only). Python's scope query doesn't emit
  // `@declaration.qualified_name` for nested methods, so the finalized
  // defs arrive here with simple names — we stamp the qualifier while
  // we're already walking class scopes for ownerId.
  const qualify = (def: SymbolDefinition, classDef: SymbolDefinition): void => {
    const q = def.qualifiedName;
    if (q === undefined || q.length === 0) return;
    if (q.includes('.')) return; // already qualified (dotted)
    const classQ = classDef.qualifiedName;
    if (classQ === undefined || classQ.length === 0) return;
    (def as { qualifiedName: string }).qualifiedName = `${classQ}.${q}`;
  };

  // Depth invariant (verified empirically against Python scope-extractor
  // 2026-04-21): a nested `def helper` declared inside a method body
  // lives in its OWN Function scope whose parent is the method's Function
  // scope (not the Class scope). That means the `parentScope.kind ===
  // 'Class'` branch below only matches DIRECT class-scope children —
  // method defs themselves — and never stamps arbitrary nested defs with
  // `ownerId = classDef.nodeId`. If an adversarial reviewer raises this
  // as a potential false-attribution bug, verify first with a scope dump
  // on `class U: def save(self): def helper(): ...` — helper.ownerId will
  // remain undefined. The theoretical concern is real only if the
  // extractor ever stops creating scopes for inner defs.
  for (const scope of parsed.scopes) {
    // Methods: function scope whose parent is a Class scope. Owner is
    // the parent's class-like def.
    if (scope.parent !== null) {
      const parentScope = scopesById.get(scope.parent);
      if (parentScope !== undefined && parentScope.kind === 'Class') {
        const classDef = parentScope.ownedDefs.find((d) => isClassLike(d.type));
        if (classDef !== undefined) {
          for (const def of scope.ownedDefs) {
            (def as { ownerId?: string }).ownerId = classDef.nodeId;
            qualify(def, classDef);
          }
        }
      }
    }
    // Class-body fields: defs directly owned by a Class scope (the
    // class-like def itself excluded).
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((d) => isClassLike(d.type));
      if (classDef !== undefined) {
        for (const def of scope.ownedDefs) {
          if (def === classDef) continue;
          (def as { ownerId?: string }).ownerId = classDef.nodeId;
          qualify(def, classDef);
        }
      }
    }
  }
}

/**
 * Walk a scope chain upward looking for the innermost enclosing
 * Class scope and return that class's def. Used by per-language
 * `super` receiver branches to discover the dispatch base.
 */
export function findEnclosingClassDef(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      const cd = scope.ownedDefs.find((d) => isClassLike(d.type));
      if (cd !== undefined) return cd;
    }
    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Find a free-function def by simple name across all parsed files,
 * preferring scope-chain-visible bindings (import + finalized scope
 * bindings) before falling back to a workspace-wide simple-name scan.
 *
 * The fallback scan is intentionally loose so per-language compound
 * resolvers can find a callable target even when the binding chain
 * doesn't surface it (e.g. cross-package re-exports the finalize
 * pass missed). Strictly-typed languages may want to disable the
 * fallback by simply not calling this helper from their compound
 * resolver.
 */
export function findExportedDefByName(
  name: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = inScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) break;
    const local = scope.bindings.get(name);
    if (local !== undefined) {
      for (const b of local) {
        if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
      }
    }
    const finalized = lookupBindingsAt(currentId, name, scopes);
    for (const b of finalized) {
      if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
    }
    currentId = scope.parent;
  }
  // Workspace-wide fallback: iterate every file's Module scope (via
  // the scope-tied `moduleScopeByFile` lookup) and return the first
  // locally-declared callable binding matching `name`. First-seen-
  // by-file wins; bindings filtered to `origin === 'local'` and the
  // callable types Function/Method/Constructor. We walk scopes here
  // rather than consult `SemanticModel.symbols.lookupCallableByName`
  // because the `origin === 'local'` module-export-visibility filter
  // is a scope concept the raw symbol index doesn't express.
  for (const [, moduleScope] of index.moduleScopeByFile) {
    const refs = moduleScope.bindings.get(name);
    if (refs === undefined) continue;
    for (const ref of refs) {
      if (ref.origin !== 'local') continue;
      const t = ref.def.type;
      if (t === 'Function' || t === 'Method' || t === 'Constructor') return ref.def;
    }
  }
  return undefined;
}

/**
 * Find a member of a class by simple name — delegates to
 * `SemanticModel.methods` (methods / functions / constructors) with a
 * fallback to `SemanticModel.fields` (properties / fields /
 * variables). After `runScopeResolution`'s reconciliation pass
 * populates both registries from `parsed.localDefs[i].ownerId`
 * (post-`populateOwners`), this is the single authoritative view of
 * class membership — no parallel scope-resolution index needed.
 *
 * Returns the first-seen overload for methods without arity or
 * return-type narrowing. Callers that need arity-aware dispatch use
 * `lookupMethodByOwner(owner, name, argCount)` directly.
 */
export function findOwnedMember(
  ownerDefId: string,
  memberName: string,
  model: SemanticModel,
): SymbolDefinition | undefined {
  const method = model.methods.lookupAllByOwner(ownerDefId, memberName)[0];
  if (method !== undefined) return method;
  return model.fields.lookupFieldByOwner(ownerDefId, memberName);
}

/**
 * Find a file-level def (top-of-module class / function / variable)
 * by simple name — consults the target file's Module scope's
 * finalized bindings. Only defs bound at module-scope with
 * `origin === 'local'` qualify, matching the historical
 * "module-export-visible" semantics. Class methods and class-body
 * fields bind at their containing class scope and are naturally
 * excluded.
 *
 * Reads from `WorkspaceResolutionIndex.moduleScopeByFile` (scope-tied
 * lookup that doesn't live on `SemanticModel`). This intentionally
 * does NOT call `lookupBindingsAt`: `findExportedDef` answers "what
 * did the target file declare locally at module scope?", while
 * `bindingAugmentations` models importer-side visibility created by
 * post-finalize hooks. Callers that need importer-visible exports use
 * `findExportedDefByName`, which is dual-channel aware.
 */
export function findExportedDef(
  targetFile: string,
  memberName: string,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  const moduleScope = index.moduleScopeByFile.get(targetFile);
  if (moduleScope === undefined) return undefined;
  const refs = moduleScope.bindings.get(memberName);
  if (refs === undefined) return undefined;
  for (const ref of refs) {
    if (ref.origin === 'local') return ref.def;
  }
  return undefined;
}
