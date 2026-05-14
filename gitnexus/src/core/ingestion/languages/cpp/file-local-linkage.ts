import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { isCppInlineNamespaceScope } from './inline-namespaces.js';

/**
 * Per-file set of symbol names with file-local linkage.
 * In C++ there are two sources of file-local linkage:
 *   1. `static` storage class (same as C)
 *   2. Anonymous namespace (`namespace { ... }`)
 *
 * Populated during `emitCppScopeCaptures` and consumed by
 * `expandCppWildcardNames` to exclude file-local symbols from
 * cross-file wildcard import visibility.
 *
 * NOTE: module-level state, single-process-single-repo use only.
 * Call `clearFileLocalNames()` at the start of each resolution pass.
 *
 * Key: filePath, Value: Set of file-local symbol names.
 */
const fileLocalNames = new Map<string, Set<string>>();

/**
 * Per-file set of `SymbolDefinition.nodeId`s that are NOT visible by
 * unqualified lookup from outside the file — class-owned methods/fields
 * and namespace-nested symbols. Populated by `populateCppNonGloballyVisible`
 * during the per-file `populateOwners` hook; consumed by
 * `isCppDefGloballyVisible` from both `expandCppWildcardNames` (wildcard
 * propagation) and the global free-call fallback's `isFileLocalDef` hook.
 *
 * Tracked per filePath rather than as a single global set so cross-file
 * lookup correctly compares the candidate's owning file's non-visible
 * set without leaking across pipeline invocations (the global free-call
 * fallback checks `def.filePath !== callerFilePath` and then asks "is
 * this def visible from outside its own file?" — that's exactly what
 * this set encodes).
 */
const nonGloballyVisibleNodeIds = new Map<string, Set<string>>();

/** Record a symbol name as file-local (static or anonymous namespace). */
export function markFileLocal(filePath: string, name: string): void {
  let names = fileLocalNames.get(filePath);
  if (names === undefined) {
    names = new Set<string>();
    fileLocalNames.set(filePath, names);
  }
  names.add(name);
}

/** Check whether a symbol name has file-local linkage in the given file. */
export function isFileLocal(filePath: string, name: string): boolean {
  return fileLocalNames.get(filePath)?.has(name) ?? false;
}

/** Clear tracked file-local names (call at start of each resolution pass). */
export function clearFileLocalNames(): void {
  fileLocalNames.clear();
  nonGloballyVisibleNodeIds.clear();
}

/**
 * Populate per-file "not globally visible" nodeIds by walking the parsed
 * file's scopes. Run as part of the `populateOwners` hook so every C++
 * scope is reflected before any cross-file resolution pass consults the
 * set.
 *
 * A def is "not globally visible" when its nearest structurally enclosing
 * scope is a `Namespace` or `Class` — those require qualification
 * (`ns::name`, `Class::method`) for cross-file unqualified lookup.
 * Module-scoped defs remain globally visible.
 */
export function populateCppNonGloballyVisible(parsed: {
  readonly filePath: string;
  readonly scopes: readonly {
    readonly id: ScopeId;
    readonly kind: string;
    readonly ownedDefs: readonly { readonly nodeId: string }[];
  }[];
}): void {
  let set = nonGloballyVisibleNodeIds.get(parsed.filePath);
  if (set === undefined) {
    set = new Set<string>();
    nonGloballyVisibleNodeIds.set(parsed.filePath, set);
  }
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Namespace' && scope.kind !== 'Class') continue;
    // Inline namespaces (`inline namespace v1 { ... }`) propagate their
    // members to the enclosing namespace's unqualified-lookup scope per
    // ISO C++ `[namespace.def]/p4`. Skip them here so cross-file
    // unqualified lookup can still see their callable defs.
    if (scope.kind === 'Namespace' && isCppInlineNamespaceScope(scope.id)) continue;
    for (const def of scope.ownedDefs) {
      set.add(def.nodeId);
    }
  }
}

/**
 * Check whether a def is visible by unqualified lookup from outside its
 * own file. Returns `false` for class-owned and namespace-nested defs.
 *
 * Used by the global free-call fallback's `isFileLocalDef` hook (which
 * historically meant "static / anonymous-namespace" but semantically
 * stands for "logically invisible cross-file"). Including class methods
 * and namespace members under the same negative answer fixes the leak
 * where unqualified `save()` resolved to `User::save` through a shared
 * workspace registry walk.
 */
export function isCppDefGloballyVisible(filePath: string, nodeId: string): boolean {
  return nonGloballyVisibleNodeIds.get(filePath)?.has(nodeId) !== true;
}

/**
 * Return the names visible through a C++ wildcard import (`#include` or
 * `using namespace`).
 *
 * ## Contract
 *
 * C++ unqualified name lookup only sees names at the importer's enclosing
 * scope. Class members and namespace-nested symbols are NOT visible by
 * unqualified lookup from a free function in an including TU — they must
 * be reached via `Class::method`, `ns::name`, or a working `using`
 * declaration. The filter below enforces that contract for header
 * propagation: only defs whose nearest enclosing scope is the header's
 * `Module` scope are emitted as wildcard-binding names.
 *
 * ## Why scope-aware and not predicate-on-qualifiedName
 *
 * A naive `def.qualifiedName.indexOf('.') === -1` check is unreliable
 * because `populateClassOwnedMembers`
 * (`gitnexus/src/core/ingestion/scope-resolution/scope/walkers.ts`)
 * only dot-qualifies `qualifiedName` for `Class` scopes. Namespace-nested
 * defs (`namespace ns { void foo(); }`) arrive in `localDefs` with
 * `qualifiedName === 'foo'` and `ownerId === undefined`, indistinguishable
 * from a top-level free function. The structural truth lives in
 * `Scope.ownedDefs`: each scope lists what it structurally owns; the
 * Module scope owns only top-level symbols. We look the def up by
 * `nodeId` against the scope tree to identify its owning kind.
 *
 * ## `localDefs` consumer survey (recorded for future maintainers)
 *
 * Other consumers of `ParsedFile.localDefs` were audited at the time
 * this filter was introduced (see PR #1520 / plan
 * `docs/plans/2026-05-12-002-fix-cpp-resolver-followups-plan.md`):
 *
 *   - `finalize-orchestrator.ts:113,163` — flattens defs into a workspace
 *     registry keyed by `ownerId` + `qualifiedName`; class-owned and
 *     namespace-owned symbols are registered under their owner, not as
 *     unqualified names. Not a leak surface.
 *   - `csharp/namespace-siblings.ts:307`, `go/expand-wildcards.ts:86`,
 *     `php/scope-resolver.ts:141,151`, `c/static-linkage.ts:51` — other
 *     languages' own wildcard / sibling expansions. Each owns its own
 *     visibility contract.
 *   - `receiver-bound-calls.ts:99`, `reconcile-ownership.ts:66,119`,
 *     `mro.ts:61` — keyed by `ownerId` for member lookup, never used
 *     as unqualified bindings.
 *   - `go/interface-impls.ts:40,53`, `go/package-siblings.ts:41` — Go-
 *     specific, sibling-package scoped.
 *
 * No other consumer treats `localDefs` as a flat unqualified-binding
 * set the way this function did before the fix. If a future consumer
 * does, mirror this filter or harden registration so class/namespace
 * members never enter `localDefs` unqualified.
 */
export function expandCppWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];

  // Build nodeId → owning Scope map from the structural scope tree.
  // `Scope.ownedDefs` is the canonical source of structural ownership;
  // `localDefs` is its flattened union, which is why the original code
  // leaked: walking only `localDefs` discards the owning-scope context.
  const ownerScopeByNodeId = new Map<string, Scope>();
  for (const scope of target.scopes) {
    for (const ownedDef of scope.ownedDefs) {
      ownerScopeByNodeId.set(ownedDef.nodeId, scope);
    }
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    // Defense-in-depth: class methods carry a non-undefined ownerId after
    // `populateClassOwnedMembers` runs. Skip them outright.
    if (def.ownerId !== undefined) continue;

    // Structural visibility check: exclude defs whose owning scope is a
    // Namespace or Class — these require qualification (`ns::name`,
    // `Class::method`) and are NOT reachable by unqualified lookup in an
    // including TU. When the owning scope is unknown we default to
    // include (preserves prior behavior for any def whose structural
    // ownership wasn't recorded in `Scope.ownedDefs`).
    const ownerScope = ownerScopeByNodeId.get(def.nodeId);
    if (
      ownerScope !== undefined &&
      (ownerScope.kind === 'Namespace' || ownerScope.kind === 'Class')
    ) {
      continue;
    }

    const name = simpleName(def);
    if (name === '') continue;
    if (isFileLocal(target.filePath, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}
