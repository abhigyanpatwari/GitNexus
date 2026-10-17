import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';

interface SelfBoundCallables {
  readonly owners: ReadonlyMap<string, ScopeId>;
  readonly parents: ReadonlyMap<ScopeId, ScopeId | null>;
}

const indexes = new WeakMap<ParsedFile, SelfBoundCallables>();

/** Named function expressions bind their name inside themselves, never globally. */
export const isJsSelfBoundCallableFallbackPlausible: NonNullable<
  ScopeResolver['isGlobalNameFallbackPlausible']
> = ({ callerParsed, candidate, parsedFileOf, site }) => {
  const parsed = parsedFileOf(candidate.filePath);
  if (parsed === undefined) return true;
  let index = indexes.get(parsed);
  if (index === undefined) {
    const owners = new Map<string, ScopeId>();
    const parents = new Map<ScopeId, ScopeId | null>();
    for (const scope of parsed.scopes) {
      parents.set(scope.id, scope.parent);
      if (scope.kind !== 'Function') continue;
      const ownCallables = new Set(
        scope.ownedDefs.filter((def) => def.type === 'Function').map((def) => def.nodeId),
      );
      if (ownCallables.size === 0) continue;
      for (const bindings of scope.bindings.values()) {
        for (const binding of bindings) {
          if (ownCallables.has(binding.def.nodeId)) owners.set(binding.def.nodeId, scope.id);
        }
      }
    }
    index = { owners, parents };
    indexes.set(parsed, index);
  }
  const owner = index.owners.get(candidate.nodeId);
  if (owner === undefined) return true;
  if (callerParsed.filePath !== candidate.filePath) return false;
  if (site.inScope === undefined) return true;
  for (
    let scope: ScopeId | null | undefined = site.inScope;
    scope != null;
    scope = index.parents.get(scope)
  ) {
    if (scope === owner) return true;
  }
  return false;
};
