import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

export function rustBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  // Keep self typeBindings in the method's Function scope so
  // populateRustOwners can match Method defs to their receiver types.
  if (decl['@type-binding.self'] !== undefined) {
    return innermost.id;
  }
  return null;
}

/**
 * Rust `use` statements inside a function body should attach at function scope,
 * not module scope. If the innermost scope is a Function, attach there.
 */
export function rustImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Function') {
    return innermost.id;
  }
  return null;
}

export function rustReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  for (const binding of functionScope.typeBindings.values()) {
    if (binding.source === 'self') return binding;
  }
  return null;
}
