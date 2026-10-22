import type { Range, ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { bindsTypeParameter, isClassLike } from '../../scope-resolution/scope/walkers.js';

/** Check lexical owners, excluding the finalize channel's hoisted declarations. */
export function isCppNamespaceQualifierShadowed(
  name: string,
  inScope: ScopeId,
  indexes: ScopeResolutionIndexes,
  position?: Pick<Range, 'startLine' | 'startCol'>,
): boolean {
  if (bindsTypeParameter(inScope, name, indexes)) return true;
  const seen = new Set<ScopeId>();
  let id: ScopeId | null = inScope;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const scope = indexes.scopeTree.getScope(id);
    if (scope === undefined) break;
    if (
      scope.bindings.get(name)?.some((binding) => {
        if (
          !isClassLike(binding.def.type) &&
          binding.def.type !== 'Typedef' &&
          binding.def.type !== 'TypeAlias'
        )
          return false;
        const at =
          binding.availableFrom ?? binding.declarationRange ?? binding.def.declarationRange;
        return (
          position === undefined ||
          at === undefined ||
          scope.kind === 'Class' ||
          at.startLine < position.startLine ||
          (at.startLine === position.startLine && at.startCol <= position.startCol)
        );
      })
    )
      return true;
    id = scope.parent;
  }
  return false;
}
