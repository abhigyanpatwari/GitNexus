import type { ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { findClassBindingInScope } from '../../scope-resolution/scope/walkers.js';

export function swiftIsCallableVisibleFromCaller(ctx: {
  readonly candidate: SymbolDefinition;
  readonly callerScope?: ScopeId;
  readonly scopes?: ScopeResolutionIndexes;
}): boolean {
  if (ctx.callerScope === undefined || ctx.scopes === undefined) return true;

  const name = ctx.candidate.qualifiedName?.split('.').at(-1);
  if (name === undefined) return true;

  let scopeId: ScopeId | null = ctx.callerScope;
  let selfType: TypeRef | undefined;
  while (scopeId !== null) {
    const scope = ctx.scopes.scopeTree.getScope(scopeId);
    if (scope === undefined) break;
    selfType ??= scope.typeBindings.get('self');
    if (scope.kind === 'Class') {
      // An unqualified call binds the nearest type's stored property before
      // any same-named method found elsewhere in the module.
      if (
        scope.ownedDefs.some(
          (def) => def.type === 'Property' && def.qualifiedName?.split('.').at(-1) === name,
        )
      )
        return false;

      const classDef =
        scope.ownedDefs.find((def) => def.type === 'Class') ??
        (selfType === undefined
          ? undefined
          : findClassBindingInScope(ctx.callerScope, selfType.rawName, ctx.scopes, undefined, {
              uniqueQualifiedNameFallback: false,
            }));
      if (classDef === undefined) return true;
      for (const ownerId of ctx.scopes.methodDispatch.mroFor(classDef.nodeId)) {
        const ownerName = ctx.scopes.defs.get(ownerId)?.qualifiedName;
        if (ownerName === undefined) continue;
        for (const defId of ctx.scopes.qualifiedNames.get(`${ownerName}.${name}`)) {
          const def = ctx.scopes.defs.get(defId);
          if (def?.type === 'Property' && def.ownerId === ownerId) return false;
        }
      }
      return true;
    }
    scopeId = scope.parent;
  }
  return true;
}
