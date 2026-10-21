import type { ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { bindsTypeParameter } from '../../scope-resolution/scope/walkers.js';

/** Check lexical owners, excluding the finalize channel's hoisted declarations. */
export function isCppNamespaceQualifierShadowed(
  name: string,
  inScope: ScopeId,
  indexes: ScopeResolutionIndexes,
): boolean {
  if (bindsTypeParameter(inScope, name, indexes)) return true;
  const seen = new Set<ScopeId>();
  let id: ScopeId | null = inScope;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const scope = indexes.scopeTree.getScope(id);
    if (scope === undefined) break;
    if (
      scope.typeBindings.has(name) ||
      scope.bindings.get(name)?.some((binding) => binding.def.type !== 'Namespace')
    )
      return true;
    id = scope.parent;
  }
  return false;
}
