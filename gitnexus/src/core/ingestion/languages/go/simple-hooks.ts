import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

export function goBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  // Keep self typeBindings in the method's Function scope (prevent
  // auto-hoist to Module) so populateGoOwners can match Method defs
  // to their receiver types by inspecting each Function scope.
  if (decl['@type-binding.self'] !== undefined) {
    return innermost.id;
  }
  return null; // default auto-hoist for other bindings
}

export function goImportOwningScope(
  _imp: ParsedImport,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

export function goReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  for (const binding of functionScope.typeBindings.values()) {
    if (binding.source === 'self') return binding;
  }
  return null;
}
