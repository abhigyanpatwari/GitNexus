import type { ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

interface LookupCache {
  readonly byName: Map<string, Map<ScopeId, ScopeId>>;
  readonly callerStarts: Map<ScopeId, ScopeId>;
  readonly callerChildren: Map<ScopeId, readonly ScopeId[]>;
  entries: number;
  readonly limit: number;
}
const caches = new WeakMap<ScopeResolutionIndexes, LookupCache>();

/** Cache navigation only for this synchronous read-only pass. Keep the index
 * identity: provider-specific lookup state can be keyed by the same object.
 * The callback, including provider and recorder hooks, must not write scope,
 * binding, import or namespace indexes while the cache is installed. */
export function withCachedNameLookups<T>(scopes: ScopeResolutionIndexes, read: () => T): T {
  const previous = caches.get(scopes);
  caches.set(scopes, {
    byName: new Map(),
    callerStarts: new Map(),
    callerChildren: new Map(),
    entries: 0,
    limit: scopes.scopeTree.size * 8,
  });
  try {
    return read();
  } finally {
    if (previous === undefined) caches.delete(scopes);
    else caches.set(scopes, previous);
  }
}

/** Position checks only inspect children that own a definition. Cache that
 * list so many calls in one function do not rescan all its empty closures. */
export function cachedCallerChildren(
  id: ScopeId,
  scopes: ScopeResolutionIndexes,
): readonly ScopeId[] {
  const cache = caches.get(scopes)?.callerChildren;
  if (cache === undefined) return scopes.scopeTree.getChildren(id);
  let children = cache.get(id);
  if (children === undefined) {
    children = scopes.scopeTree
      .getChildren(id)
      .filter((child) => (scopes.scopeTree.getScope(child)?.ownedDefs.length ?? 0) > 0);
    cache.set(id, children);
  }
  return children;
}

/** Caller attribution also checks child definitions against the call position.
 * Skip only scopes with neither own nor child definitions; retain every scope
 * that could affect that position-sensitive choice. At most one entry/scope. */
export function cachedCallerLookupStart(start: ScopeId, scopes: ScopeResolutionIndexes): ScopeId {
  const cache = caches.get(scopes)?.callerStarts;
  if (cache === undefined) return start;
  const path: ScopeId[] = [];
  const seen = new Set<ScopeId>();
  let id = start;
  while (true) {
    const known = cache.get(id);
    if (known !== undefined) {
      id = known;
      break;
    }
    if (seen.has(id)) return start;
    seen.add(id);
    const scope = scopes.scopeTree.getScope(id);
    if (scope === undefined) return start;
    if (
      scope.parent === null ||
      scope.ownedDefs.length > 0 ||
      cachedCallerChildren(id, scopes).length > 0
    )
      break;
    path.push(id);
    id = scope.parent;
  }
  for (const skipped of path) cache.set(skipped, id);
  return id;
}

/** Path-compress scopes with no possible fact for this spelling. This caches
 * navigation only; ownership, source-position filtering and targets still go
 * through lookupLexicalName. Policies and imports are conservative barriers.
 * A lookup that skips enclosing classes depends on every scope on its way, so
 * it keeps its own start. The entry cap bounds memory by scope count even with
 * many distinct names. */
export function cachedNameLookupStart(
  start: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
  skipEnclosingClasses = false,
): ScopeId {
  const cache = caches.get(scopes);
  if (cache === undefined || skipEnclosingClasses || scopes.workspaceFqnBindings?.has(name))
    return start;
  let byScope = cache.byName.get(name);
  const known = byScope?.get(start);
  if (known !== undefined) return known;
  if (cache.entries >= cache.limit) return start;
  const path: ScopeId[] = [];
  const seen = new Set<ScopeId>();
  let id = start;
  while (true) {
    const cached = byScope?.get(id);
    if (cached !== undefined) {
      id = cached;
      break;
    }
    if (seen.has(id)) return start;
    seen.add(id);
    const scope = scopes.scopeTree.getScope(id);
    if (scope === undefined || scope.kind === 'Object' || scope.lookupPolicy !== undefined)
      return start;
    if (
      scope.parent === null ||
      scope.bindings.has(name) ||
      scope.typeBindings.has(name) ||
      scope.lexicalNames?.has(name) ||
      scope.ownsReceivers?.has(name) ||
      (scope.nameClaims?.length ?? 0) > 0 ||
      scope.imports.length > 0 ||
      (scopes.imports.edgesAt(id)?.length ?? 0) > 0 ||
      scopes.bindings.get(id)?.has(name) ||
      scopes.bindingAugmentations.get(id)?.has(name) ||
      scopes.accessibleNamespacesByScope?.has(id) ||
      scopes.namespaceLookupTiersByScope?.has(id)
    )
      break;
    path.push(id);
    id = scope.parent;
  }
  // Terminal scopes need no shortcut. Avoid retaining an empty map for each
  // distinct spelling when every lookup already starts at such a scope.
  if (path.length === 0) return id;
  if (byScope === undefined) cache.byName.set(name, (byScope = new Map()));
  for (const skipped of path) {
    if (cache.entries >= cache.limit) break;
    byScope.set(skipped, id);
    cache.entries++;
  }
  return id;
}
