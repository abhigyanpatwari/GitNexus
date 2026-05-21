import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

export function kotlinBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (decl['@type-binding.return'] === undefined) return null;

  let current: Scope | undefined = innermost;
  while (current !== undefined && current.kind !== 'Module') {
    if (current.parent === null) break;
    current = tree.getScope(current.parent);
  }
  return current?.kind === 'Module' ? current.id : null;
}

export function kotlinImportOwningScope(
  _imp: ParsedImport,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

export function kotlinReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('this') ?? functionScope.typeBindings.get('super') ?? null;
}
