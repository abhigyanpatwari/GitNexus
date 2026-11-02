import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

/**
 * C++ binding scope: default auto-hoist (null) for most declarations.
 *
 * For `for` statement init-scope variables (e.g. `for (int i = 0; ...)`),
 * the variable is scoped to the for-block, not the enclosing function.
 * The tree-sitter scope query already captures for_statement as @scope.block,
 * so tree-sitter's scope nesting handles this automatically — we return null
 * to let the default auto-hoist apply.
 */
export function cppBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  // Keep each callable's return fact with its declaring owner. In particular,
  // a free prototype must not overwrite a same-name method's return type.
  if (decl['@type-binding.return'] !== undefined) {
    let current: Scope | undefined = innermost;
    while (current !== undefined) {
      if (current.kind === 'Class' || current.kind === 'Namespace' || current.kind === 'Module')
        return current.id;
      current = current.parent === null ? undefined : tree.getScope(current.parent);
    }
  }
  return null; // default auto-hoist for other bindings
}

/**
 * C++ import owning scope: default (null).
 * #include and using declarations are file-scoped in C++.
 */
export function cppImportOwningScope(
  _imp: ParsedImport,
  _innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return null;
}

/**
 * C++ receiver binding: return `this` TypeRef for methods inside a class.
 *
 * When a function scope is inside a class scope, the implicit `this` pointer
 * refers to the enclosing class. This enables `this->method()` and implicit
 * `this` member access resolution.
 */
export function cppReceiverBinding(functionScope: Scope): TypeRef | null {
  // Walk up the scope tree to find an enclosing class scope
  if (functionScope.parent === null) return null;

  // The scope tree structure nests function scopes inside class scopes.
  // The orchestrator provides the function scope; we need to check if
  // its parent chain contains a class scope.
  //
  // However, the ScopeResolver.receiverBinding contract receives only
  // the function Scope (not the full ScopeTree), and the Scope type
  // includes `parent` (a ScopeId) but not a reference to the parent
  // Scope object.
  //
  // The orchestrator already handles this by looking up the class owner
  // via populateOwners. We return null here and let the shared infra
  // handle receiver resolution through the class-ownership mechanism.
  //
  // This is consistent with how C# and Go handle it — the receiver
  // binding is established through populateOwners + the MRO chain,
  // not through this hook.
  return null;
}
