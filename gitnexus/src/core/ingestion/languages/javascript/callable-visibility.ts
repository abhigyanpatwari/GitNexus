import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';

interface SelfBoundCallables {
  readonly owners: ReadonlyMap<string, ScopeId>;
  readonly parents: ReadonlyMap<ScopeId, ScopeId | null>;
  readonly unbound: ReadonlySet<string>;
}

const indexes = new WeakMap<ParsedFile, SelfBoundCallables>();

/** Named expressions bind privately; anonymous display names are never bindings. */
export const isJsSelfBoundCallableFallbackPlausible: NonNullable<
  ScopeResolver['isGlobalNameFallbackPlausible']
> = ({ callerParsed, candidate, parsedFileOf, site }) => {
  const parsed = parsedFileOf(candidate.filePath);
  if (parsed === undefined) return true;
  let index = indexes.get(parsed);
  if (index === undefined) {
    const owners = new Map<string, ScopeId>();
    const parents = new Map<ScopeId, ScopeId | null>();
    const bound = new Set<string>();
    const callables = new Set<string>();
    for (const scope of parsed.scopes) {
      parents.set(scope.id, scope.parent);
      const ownCallables = new Set(
        scope.kind === 'Function'
          ? scope.ownedDefs.filter((def) => def.type === 'Function').map((def) => def.nodeId)
          : [],
      );
      for (const id of ownCallables) callables.add(id);
      for (const bindings of scope.bindings.values()) {
        for (const binding of bindings) {
          bound.add(binding.def.nodeId);
          if (ownCallables.has(binding.def.nodeId)) owners.set(binding.def.nodeId, scope.id);
        }
      }
    }
    for (const id of bound) callables.delete(id);
    index = { owners, parents, unbound: callables };
    indexes.set(parsed, index);
  }
  if (index.unbound.has(candidate.nodeId)) return false;
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
