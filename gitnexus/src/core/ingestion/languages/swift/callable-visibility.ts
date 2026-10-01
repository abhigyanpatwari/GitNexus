import type { ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

export function swiftIsCallableVisibleFromCaller(ctx: {
  readonly candidate: SymbolDefinition;
  readonly callerScope?: ScopeId;
  readonly scopes?: ScopeResolutionIndexes;
}): boolean {
  if (ctx.callerScope === undefined || ctx.scopes === undefined) return true;

  const name = ctx.candidate.qualifiedName?.split('.').at(-1);
  if (name === undefined) return true;

  let scopeId: ScopeId | null = ctx.callerScope;
  while (scopeId !== null) {
    const scope = ctx.scopes.scopeTree.getScope(scopeId);
    if (scope === undefined) break;
    if (scope.kind === 'Class') {
      // An unqualified call binds the nearest type's stored property before
      // any same-named method found elsewhere in the module.
      return !scope.ownedDefs.some(
        (def) => def.type === 'Property' && def.qualifiedName?.split('.').at(-1) === name,
      );
    }
    scopeId = scope.parent;
  }
  return true;
}
