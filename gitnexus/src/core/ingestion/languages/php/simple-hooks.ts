/**
 * Trivial / no-op-ish hooks for the PHP provider. Made explicit so
 * reviewers don't have to re-derive the analysis from "absence == default".
 */

import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
} from 'gitnexus-shared';

// ─── bindingScopeFor ──────────────────────────────────────────────────────

/**
 * PHP method return-type bindings (`@type-binding.return`) must hoist
 * to the enclosing Module scope so `propagateImportedReturnTypes` can
 * mirror them across files. Without this hoist, the return binding gets
 * stuck at the Class scope and is invisible to the cross-file propagation
 * pass that reads only `sourceModule.typeBindings`.
 *
 * All other bindings delegate to the default "innermost scope" rule.
 */
export function phpBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  if (decl['@type-binding.return'] !== undefined) {
    let cur: Scope | undefined = innermost;
    while (cur !== undefined && cur.kind !== 'Module') {
      const parentId: ScopeId | null = cur.parent ?? null;
      if (parentId === null) break;
      cur = tree.getScope(parentId);
    }
    if (cur !== undefined && cur.kind === 'Module') return cur.id;
  }

  // Constructor-promoted properties (`function __construct(public User $u)`)
  // are declared inside the constructor's Function scope in the AST, but they
  // are class-owned fields. Hoist the @declaration.property binding to the
  // enclosing Class scope so `populateClassOwnedMembers` assigns the correct
  // ownerId and `findOwnedMember` can resolve `$obj->u`.
  if (decl['@declaration.property'] !== undefined && innermost.kind === 'Function') {
    let cur: Scope | undefined = innermost;
    while (cur !== undefined && cur.kind !== 'Class') {
      const parentId: ScopeId | null = cur.parent ?? null;
      if (parentId === null) break;
      cur = tree.getScope(parentId);
    }
    if (cur !== undefined && cur.kind === 'Class') return cur.id;
  }

  // Constructor-promoted property TYPE BINDING (`function __construct(public Address $address)`)
  // produces both a @type-binding.parameter (stays in Function scope for `$address` lookups
  // inside the constructor body) AND a @type-binding.annotation (query.ts). The annotation
  // capture is emitted so this hoist branch can place `address → Address` in the CLASS scope.
  //
  // The compound-receiver resolver (`resolveCompoundReceiverClass`) reads typeBindings from
  // the class scope: `cs.typeBindings.get('address')`. Without hoisting, `$user->address->save()`
  // fails to resolve `address` because the type binding is in the constructor's Function scope.
  //
  // `@type-binding.annotation` for a promoted param appears with innermost = Function scope
  // (the constructor). Regular typed class properties (`private Address $addr;`) have their
  // annotation already in the Class scope, so this branch only fires for promoted params.
  if (decl['@type-binding.annotation'] !== undefined && innermost.kind === 'Function') {
    let cur: Scope | undefined = innermost;
    while (cur !== undefined && cur.kind !== 'Class') {
      const parentId: ScopeId | null = cur.parent ?? null;
      if (parentId === null) break;
      cur = tree.getScope(parentId);
    }
    if (cur !== undefined && cur.kind === 'Class') return cur.id;
  }

  return null;
}

// ─── importOwningScope ────────────────────────────────────────────────────

/**
 * Determine which scope owns a `use` import declaration.
 *
 *   - `use` inside `namespace Foo { }` → attach to that Namespace scope.
 *   - Top-level `use` (no enclosing namespace) → innermost (Module).
 *   - `use TraitName;` inside a class body → this is a trait-use
 *     (heritage), NOT a namespace import. The grammar emits
 *     `use_declaration` for trait-use (distinct from
 *     `namespace_use_declaration`). Our query only captures
 *     `namespace_use_declaration`, so trait-use never reaches this hook
 *     in practice. Returning `null` here is a safety fallback.
 */
export function phpImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  // Namespace-scoped or module-scoped imports attach to the innermost scope
  // (either Namespace or Module). Class-scoped imports should not occur for
  // namespace_use_declaration; if they do, attach to the class scope.
  if (
    innermost.kind === 'Namespace' ||
    innermost.kind === 'Module' ||
    innermost.kind === 'Class' ||
    innermost.kind === 'Function'
  ) {
    return innermost.id;
  }
  return null;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/**
 * Look up `$this` or `parent` in the function scope's type bindings.
 *
 * Both are synthesized as `@type-binding.self` captures during capture
 * emission (`receiver-binding.ts`) — `$this` for every non-static
 * method inside a class/trait/interface/enum body, `parent` additionally
 * for class methods with an explicit `base_clause`.
 *
 * Returns `null` for:
 *   - static methods (no `$this` synthesized)
 *   - free functions (no enclosing class)
 *   - non-Function scopes
 */
export function phpReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return (
    functionScope.typeBindings.get('$this') ?? functionScope.typeBindings.get('parent') ?? null
  );
}
