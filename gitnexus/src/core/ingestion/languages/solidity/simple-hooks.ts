import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

export function solidityBindingScopeFor(
  _decl: CaptureMatch,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

export function solidityImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (
    innermost.kind === 'Module' ||
    innermost.kind === 'Namespace' ||
    innermost.kind === 'Class' ||
    innermost.kind === 'Function'
  ) {
    return innermost.id;
  }
  return null;
}

export function solidityReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('this') ?? null;
}
