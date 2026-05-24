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
  // Smart-cast narrowed bindings (issue #1758) must stay at the innermost
  // (Block) scope. Their anchor coincides with the Block's range for
  // unbraced arm bodies (`is User -> obj.save()`), which would otherwise
  // trigger scope-extractor auto-hoist into the enclosing function scope
  // and erase the arm-local narrowing.
  if (decl['@type-binding.narrowed'] !== undefined) return innermost.id;

  // Lambda-scoped bindings (issue #1757) — explicit lambda parameters
  // and implicit `it` must stay inside the lambda body Block scope.
  // Without this gating, the binding hoists to the enclosing function
  // scope and:
  //   - `it` leaks past the closing brace of the lambda, shadowing the
  //     parameter-scope `it` (or outer `val it = "outer"`) for everything
  //     that follows in the function body.
  //   - Nested lambda parameters override each other across siblings.
  // Same mechanism as the smart-cast precedent above.
  if (decl['@type-binding.lambda-scoped'] !== undefined) return innermost.id;

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
