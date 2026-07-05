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
  // Keep receiver and parameter typeBindings in the function scope
  // (prevent auto-hoist to Module). Parameters are local variables:
  // hoisting `repo Repository` from one function to module scope can
  // pollute another function's local receiver resolution.
  if (decl['@type-binding.self'] !== undefined || decl['@type-binding.parameter'] !== undefined) {
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
    if (binding.source === 'self') return normalizeGoSelfTypeRef(binding);
  }
  return null;
}

function normalizeGoSelfTypeRef(binding: TypeRef): TypeRef {
  const rawName = binding.rawName.replace(/^\*+/, '').trim();
  return rawName === binding.rawName ? binding : { ...binding, rawName };
}
