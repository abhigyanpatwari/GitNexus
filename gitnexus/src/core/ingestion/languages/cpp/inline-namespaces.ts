/**
 * C++ inline namespace support (U5 of plan 2026-05-13-001).
 *
 * `inline namespace v1 { void foo(); }` has two ISO C++ semantics that
 * GitNexus must model:
 *
 *   1. **Transitive unqualified visibility.** Names declared in an inline
 *      namespace are reachable by unqualified lookup from the enclosing
 *      namespace's scope, as if they were declared directly there.
 *      `populateCppNonGloballyVisible` (file-local-linkage.ts) treats
 *      inline-namespace members as globally visible for cross-file
 *      unqualified lookup.
 *
 *   2. **Transitive qualified visibility.** `outer::foo()` resolves to
 *      `outer::v1::foo()` when `v1` is inline. The qualified-namespace
 *      receiver resolver (`resolveCppQualifiedNamespaceMember`) walks
 *      inline-namespace children transitively when collecting candidates.
 *
 * State lifecycle: capture-time `markCppInlineNamespaceRange` records each
 * inline namespace's source range; `populateCppInlineNamespaceScopes`
 * resolves ranges to `ScopeId`s during `populateOwners`. Cleared via
 * `clearCppInlineNamespaces`, called from `clearFileLocalNames`.
 *
 * STL idiom this enables: `std::__1::vector` (libc++) and `std::__cxx11`
 * (libstdc++) are inline namespaces of `std`. With this support,
 * `std::vector` qualified calls resolve to the inline-namespace
 * declaration transparently.
 */

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  isOverloadAmbiguousAfterNormalization,
  narrowOverloadCandidates,
} from '../../scope-resolution/passes/overload-narrowing.js';

interface RangeKey {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

const inlineNamespaceRangesByFile = new Map<string, Set<string>>();
const inlineNamespaceScopeIds = new Set<ScopeId>();

function rangeKey(r: RangeKey): string {
  return `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
}

/** Capture-time: record a namespace_definition's range as inline.
 *  Called from `emitCppScopeCaptures` when the tree-sitter AST shows an
 *  `inline` keyword child on `namespace_definition`. */
export function markCppInlineNamespaceRange(filePath: string, range: RangeKey): void {
  let set = inlineNamespaceRangesByFile.get(filePath);
  if (set === undefined) {
    set = new Set();
    inlineNamespaceRangesByFile.set(filePath, set);
  }
  set.add(rangeKey(range));
}

/** Clear all inline-namespace state. Called from `clearFileLocalNames`. */
export function clearCppInlineNamespaces(): void {
  inlineNamespaceRangesByFile.clear();
  inlineNamespaceScopeIds.clear();
}

/** Resolve captured ranges to actual ScopeIds by matching scope ranges
 *  against the inline-namespace ranges recorded for this file. Run from
 *  the cpp resolver's `populateOwners` hook so the per-pipeline Set is
 *  populated before any resolution pass consults it. */
export function populateCppInlineNamespaceScopes(parsed: ParsedFile): void {
  const ranges = inlineNamespaceRangesByFile.get(parsed.filePath);
  if (ranges === undefined || ranges.size === 0) return;
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Namespace') continue;
    if (ranges.has(rangeKey(scope.range))) {
      inlineNamespaceScopeIds.add(scope.id);
    }
  }
}

/** Predicate consumed by `populateCppNonGloballyVisible` to exempt
 *  inline-namespace members from cross-file unqualified-lookup
 *  exclusion (they remain reachable as if declared at the enclosing
 *  namespace's level). */
export function isCppInlineNamespaceScope(scopeId: ScopeId): boolean {
  return inlineNamespaceScopeIds.has(scopeId);
}

/**
 * Walk every parsed file looking for a Namespace scope whose qualified
 * name matches `receiverName`, collect its callable ownedDefs matching
 * `memberName`, transitively descending into any inline-namespace
 * children (since they're members of the enclosing namespace under ISO
 * C++).
 *
 * Returns the most specific (innermost) match — for `outer::foo()`
 * where `inline namespace v1` declares `foo`, returns `v1::foo`. When
 * multiple inline-namespace children declare the same name, ISO C++
 * leaves the call ambiguous; returns `'ambiguous'` so the caller
 * suppresses edge emission rather than picking arbitrarily (#1564).
 */
export function resolveCppQualifiedNamespaceMember(
  receiverName: string,
  memberName: string,
  parsedFiles: readonly ParsedFile[],
  _scopes: ScopeResolutionIndexes,
): SymbolDefinition | 'ambiguous' | undefined {
  const allHits: SymbolDefinition[] = [];
  const seenNodeId = new Set<string>();
  for (const parsed of parsedFiles) {
    const scopesById = new Map<ScopeId, (typeof parsed.scopes)[number]>();
    for (const sc of parsed.scopes) scopesById.set(sc.id, sc);
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Namespace') continue;
      const nsDef = findNamespaceDefInScope(scope);
      if (nsDef === undefined) continue;
      const nsName = nsDef.qualifiedName?.split('.').pop() ?? nsDef.qualifiedName ?? '';
      if (nsName !== receiverName) continue;
      // Found a matching namespace scope in this file. Collect ALL
      // members transitively through any inline-namespace children.
      const hits = findMemberInNamespaceTransitive(scope, scopesById, memberName);
      for (const hit of hits) {
        if (seenNodeId.has(hit.nodeId)) continue;
        seenNodeId.add(hit.nodeId);
        allHits.push(hit);
      }
    }
  }
  if (allHits.length === 0) return undefined;
  if (allHits.length === 1) return allHits[0];

  // Multi-candidate: the `resolveQualifiedReceiverMember` hook has no
  // access to call-site arity or argument types, so
  // `narrowOverloadCandidates` cannot actually narrow here — the call
  // with `(allHits, undefined, undefined)` is effectively a pass-through.
  // We retain it so that `isOverloadAmbiguousAfterNormalization` can
  // still detect int/long-style normalization collisions on this path,
  // but for any multi-hit case where candidates have genuinely distinct
  // signatures (e.g. `foo(int)` vs `foo(double)` in different inline
  // children), we conservatively suppress rather than pick arbitrarily.
  // A future enhancement could thread call-site argument info through
  // the `resolveQualifiedReceiverMember` contract to enable real
  // narrowing here.
  const narrowed = narrowOverloadCandidates(allHits, undefined, undefined);
  if (narrowed.length === 1) return narrowed[0];
  if (narrowed.length === 0) return undefined;
  if (isOverloadAmbiguousAfterNormalization(narrowed, undefined)) return 'ambiguous';
  // Multiple surviving candidates (distinct signatures) — conservative
  // suppress because we lack call-site info to disambiguate.
  return 'ambiguous';
}

/** Recursively search a namespace scope and any inline-namespace
 *  descendants for callable defs with the given simple name. Non-inline
 *  nested namespaces are NOT traversed — they require explicit
 *  qualification (`outer::nested::foo`). Returns ALL matches so the
 *  caller can detect same-name ambiguity across inline children (#1564). */
function findMemberInNamespaceTransitive(
  scope: {
    readonly id: ScopeId;
    readonly ownedDefs: readonly SymbolDefinition[];
    readonly parent: ScopeId | null;
  },
  scopesById: ReadonlyMap<
    ScopeId,
    {
      readonly id: ScopeId;
      readonly kind: string;
      readonly parent: ScopeId | null;
      readonly ownedDefs: readonly SymbolDefinition[];
    }
  >,
  memberName: string,
): SymbolDefinition[] {
  const results: SymbolDefinition[] = [];
  // Check this scope's own ownedDefs first.
  for (const def of scope.ownedDefs) {
    if (def.type !== 'Function' && def.type !== 'Method' && def.type !== 'Constructor') continue;
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    if (simple === memberName) results.push(def);
  }
  // Descend into inline-namespace children.
  for (const childScope of scopesById.values()) {
    if (childScope.parent !== scope.id) continue;
    if (childScope.kind !== 'Namespace') continue;
    if (!inlineNamespaceScopeIds.has(childScope.id)) continue;
    const childHits = findMemberInNamespaceTransitive(childScope, scopesById, memberName);
    for (const hit of childHits) results.push(hit);
  }
  return results;
}

function findNamespaceDefInScope(scope: {
  readonly ownedDefs: readonly SymbolDefinition[];
}): SymbolDefinition | undefined {
  for (const def of scope.ownedDefs) {
    if (def.type === 'Namespace') return def;
  }
  return undefined;
}
