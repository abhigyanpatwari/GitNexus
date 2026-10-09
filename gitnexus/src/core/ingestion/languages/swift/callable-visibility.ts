import type { ParsedFile, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { findClassBindingInScope } from '../../scope-resolution/scope/walkers.js';

export function swiftIsCallableVisibleFromCaller(ctx: {
  readonly candidate: SymbolDefinition;
  readonly callerParsed?: ParsedFile;
  readonly callArity?: number;
  readonly callerScope?: ScopeId;
  readonly scopes?: ScopeResolutionIndexes;
}): boolean {
  const indexes = ctx.scopes;
  if (ctx.callerScope === undefined || indexes === undefined || ctx.callArity !== 0) return true;

  const name = ctx.candidate.qualifiedName?.split('.').at(-1);
  if (name === undefined) return true;

  let scopeId: ScopeId | null = ctx.callerScope;
  let selfType: TypeRef | undefined;
  while (scopeId !== null) {
    const scope = indexes.scopeTree.getScope(scopeId);
    if (scope === undefined) break;
    // A local function selected inside the caller wins before member lookup.
    if (
      scope.kind !== 'Class' &&
      scope.ownedDefs.some((def) => def.nodeId === ctx.candidate.nodeId)
    )
      return true;
    selfType ??= scope.typeBindings.get('self');
    if (scope.kind === 'Class') {
      const classDef =
        scope.ownedDefs.find((def) => def.type === 'Class') ??
        (selfType === undefined
          ? undefined
          : findClassBindingInScope(ctx.callerScope, selfType.rawName, indexes, undefined, {
              uniqueQualifiedNameFallback: false,
            }));
      const propertyOnOwner = (ownerId: string, ownerName: string): boolean =>
        indexes.qualifiedNames.get(`${ownerName}.${name}`).some((defId) => {
          const def = indexes.defs.get(defId);
          return def?.type === 'Property' && def.ownerId === ownerId;
        });
      const ownProperty =
        scope.ownedDefs.some(
          (def) => def.type === 'Property' && def.qualifiedName?.split('.').at(-1) === name,
        ) ||
        (classDef !== undefined &&
          classDef.qualifiedName !== undefined &&
          propertyOnOwner(classDef.nodeId, classDef.qualifiedName));
      const inheritedProperty =
        classDef !== undefined &&
        indexes.methodDispatch.mroFor(classDef.nodeId).some((ownerId) => {
          const ownerName = indexes.defs.get(ownerId)?.qualifiedName;
          return ownerName !== undefined && propertyOnOwner(ownerId, ownerName);
        });
      if (!ownProperty && !inheritedProperty) return true;

      // Swift's nested function is owned by its own Function scope. A
      // same-file sibling must not count as a nearer lexical binding.
      const declarationScope = ctx.callerParsed?.scopes.find((candidateScope) =>
        candidateScope.ownedDefs.some((def) => def.nodeId === ctx.candidate.nodeId),
      );
      if (
        declarationScope !== undefined &&
        declarationScope.kind === 'Function' &&
        (declarationScope.id === ctx.callerScope ||
          indexes.scopeTree.getAncestors(declarationScope.id).includes(ctx.callerScope))
      )
        return true;

      // Scope defs do not carry Swift access modifiers. A method positively
      // selected on this type must not be vetoed by an uncertain ancestor.
      return classDef !== undefined && ctx.candidate.ownerId === classDef.nodeId;
    }
    scopeId = scope.parent;
  }
  return true;
}
