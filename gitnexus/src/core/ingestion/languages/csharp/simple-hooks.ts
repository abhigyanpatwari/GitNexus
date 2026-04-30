/**
 * Trivial / no-op-ish hooks for the C# provider. Kept together because
 * each is a few lines and they share a common theme: they make the
 * provider's choice explicit rather than relying on "absence == default"
 * so reviewers don't have to re-derive the analysis.
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

/** C# has block scope, but the central extractor's "innermost enclosing
 *  scope" default already handles it correctly: class-body declarations
 *  attach to the innermost Class scope, method-body declarations attach
 *  to the innermost Function scope, and namespace-body declarations
 *  attach to the innermost Namespace scope (which the scope query emits
 *  for both `namespace X { }` and `namespace X;` forms).
 *
 *  Exception: **method return-type bindings** (`@type-binding.return`)
 *  must hoist all the way to the Module scope. The default auto-hoist
 *  in the central extractor only promotes one level (Function → its
 *  parent). For C# methods the parent is always a Class, so without
 *  this override the return binding gets stuck at the Class scope,
 *  where it's invisible to:
 *    - chain-follow's parent-chain walk in `followChainPostFinalize`
 *      (tests: `var u = GetUser(); u.Save()` single-file);
 *    - cross-file `propagateImportedReturnTypes`, which reads only
 *      `sourceModule.typeBindings`.
 *  Walking to Module restores both paths. */
export function csharpBindingScopeFor(
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
  return null;
}

// ─── importOwningScope ────────────────────────────────────────────────────

/** `using` inside `namespace X { }` binds to that namespace's scope (its
 *  types are visible only within that namespace's members). File-level
 *  `using` delegates to the module default. Class-body `using` is not
 *  legal C# — defensively handle it by attaching to the class if it
 *  ever slips through.
 *
 *  `global using X;` (C# 10+) at the compilation_unit level is treated
 *  as a file-scoped using for Unit 2's purposes; cross-file propagation
 *  will be addressed if Unit 7's parity gate flags it. */
export function csharpImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Namespace' || innermost.kind === 'Class' || innermost.kind === 'Function')
    return innermost.id;
  return null;
}

// ─── receiverBinding ──────────────────────────────────────────────────────

/** Look up `this` or `base` in the function scope's type bindings.
 *
 *  `this` and `base` are synthesized as type bindings on instance
 *  methods during capture emission (`receiver-binding.ts`) — `this`
 *  for every method inside a class/struct/record/interface body, and
 *  `base` additionally for methods of a class-like type with an
 *  explicit `base_list`. This hook therefore returns a non-null
 *  `TypeRef` for instance-method bodies.
 *
 *  Returns `null` for:
 *    - static methods (no `this` synthesized)
 *    - free functions / module-level code (no enclosing class)
 *    - non-Function scopes
 *
 *  Matches `pythonReceiverBinding`'s shape so the two provider
 *  wirings stay symmetric. */
export function csharpReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('this') ?? functionScope.typeBindings.get('base') ?? null;
}
