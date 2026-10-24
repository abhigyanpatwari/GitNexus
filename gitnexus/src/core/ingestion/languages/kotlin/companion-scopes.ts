import type { ScopeId } from 'gitnexus-shared';

/**
 * Per-file `ScopeId`s from `companion_object` AST nodes, with a positive
 * proof when the header has no supertypes
 * (issue #1756 / U4 remediation).
 *
 * Populated during `emitKotlinScopeCaptures` from the `@scope.companion`
 * marker capture (see `query.ts`) and consumed by
 * `populateCompanionMembersOnEnclosingClass` in `owners.ts` to decide
 * whether to promote a class scope's methods onto its enclosing class.
 *
 * The previous `ownedDefs.some(isClassLike)` heuristic in `owners.ts`
 * silently misclassified two shapes as "regular classes":
 *   - named companions (`companion object Helper { ... }`) — the `Helper`
 *     `type_identifier` registered as a class-like def on the companion
 *     scope, hiding the companion-ness from the heuristic; AND
 *   - companions containing nested classes (`companion object { class
 *     Token; fun create() }`) — the nested class def lived on the
 *     companion scope, again hiding it from the heuristic.
 *
 * The marker capture lifts that distinction up to the parser layer
 * where it is unambiguous (any `companion_object` AST node is a
 * companion, regardless of what it contains).
 *
 * Parallels the C-language pattern in `c/static-linkage.ts`: per-file
 * `Map<filePath, Set<key>>` side-channel for language-specific def /
 * scope metadata that does not belong on the shared `Scope` /
 * `SymbolDefinition` types.
 *
 * NOTE: module-level state. `clearCompanionScopes()` is called once per
 * workspace pass from `kotlinScopeResolver.loadResolutionConfig`, which
 * the scope-resolution orchestrator awaits before extracting any
 * `ParsedFile`s for this language (see `pipeline/phase.ts` and the
 * mirror pattern in `c/scope-resolver.ts` — `clearStaticNames()`). This
 * keeps server-mode and multi-repo-in-one-process callers safe from
 * unbounded memory growth and from stale companion-scope ids from a
 * previous workspace's files. Tests that exercise the captures /
 * owners modules directly may still need to call `clearCompanionScopes`
 * themselves (see `test/unit/kotlin-static-marker.test.ts`).
 */
const companionScopesByFile = new Map<string, Map<ScopeId, boolean>>();

/** Record companion identity; omitted header proof remains unknown. */
export function markCompanionScope(
  filePath: string,
  scopeId: ScopeId,
  hasNoSupertypes = false,
): void {
  let scopes = companionScopesByFile.get(filePath);
  if (scopes === undefined) {
    scopes = new Map<ScopeId, boolean>();
    companionScopesByFile.set(filePath, scopes);
  }
  scopes.set(scopeId, hasNoSupertypes);
}

/** Check whether `scopeId` belongs to a companion-object scope in `filePath`. */
export function isCompanionScope(filePath: string, scopeId: ScopeId): boolean {
  return companionScopesByFile.get(filePath)?.has(scopeId) ?? false;
}

/** Only a captured header can prove that a companion has no inherited members. */
export function companionHasNoSupertypes(filePath: string, scopeId: ScopeId): boolean {
  return companionScopesByFile.get(filePath)?.get(scopeId) === true;
}

/**
 * Snapshot the companion-object scope ids recorded for `filePath` as a plain
 * array (for the worker→main capture side-channel, #1983). Returns an empty
 * array when the file recorded no companion scopes. See
 * `capture-side-channel.ts`.
 */
export function getCompanionScopesForFile(filePath: string): ScopeId[] {
  const scopes = companionScopesByFile.get(filePath);
  return scopes === undefined ? [] : [...scopes.keys()];
}

/** Positive header proofs carried through worker and cache serialization. */
export function getCompanionScopesWithoutSupertypesForFile(filePath: string): ScopeId[] {
  const scopes = companionScopesByFile.get(filePath);
  return scopes === undefined
    ? []
    : [...scopes].filter(([, hasNoSupertypes]) => hasNoSupertypes).map(([scopeId]) => scopeId);
}

/** Clear all tracked companion scopes (for testing). */
export function clearCompanionScopes(): void {
  companionScopesByFile.clear();
}
