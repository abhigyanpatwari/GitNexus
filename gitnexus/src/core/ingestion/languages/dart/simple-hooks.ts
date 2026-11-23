/**
 * Small explicit Dart scope-resolution hooks:
 *
 *   - `dartBindingScopeFor` — (1) hoists `@type-binding.return` bindings to
 *     the Module scope so chain-follow + `propagateImportedReturnTypes` see
 *     them, except a local function's, which stays where its name binds;
 *     (2) hoists function/method/constructor declaration NAMES to the
 *     enclosing parent scope, and getter / setter names too (DART-10). The
 *     second case is Dart-specific: because
 *     `function_signature`/`function_body` are siblings, the synthesized
 *     Function scope starts AT the declaration, so the central auto-hoist
 *     (which fires only when the declaration anchor range equals the scope
 *     range) does not trigger; without this the function name would bind
 *     inside its own body instead of being visible to callers/siblings.
 *   - `dartImportOwningScope` — imports attach to the Module scope only.
 *   - `dartReceiverBinding` — the implicit `this`/`super` receiver of a
 *     Function scope.
 */

import type {
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
  CaptureMatch,
} from 'gitnexus-shared';
import { walkToScope } from '../../utils/scope-tree-walk.js';

export function dartBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  // (1) Return-type bindings hoist to the Module scope — except a LOCAL
  // function's, which stays in the scope that binds the function's name.
  if (decl['@type-binding.return'] !== undefined) {
    // The binding is anchored on the signature, where the callable's own
    // Function scope starts, so `innermost` is that scope and its parent is
    // where case (2) below binds the name. A parent that is itself a body or a
    // statement scope means a local function: its name is visible only there,
    // and so is what it returns. Hoisted to the Module, `Other fetch()` inside
    // one function retyped the result of every other `fetch()` in the file —
    // the top-level or imported `User fetch()` called from another function.
    const declaring =
      innermost.kind === 'Function' && innermost.parent !== null
        ? tree.getScope(innermost.parent)
        : undefined;
    if (declaring !== undefined && (declaring.kind === 'Function' || declaring.kind === 'Block')) {
      return declaring.id;
    }
    let cur: Scope | undefined = innermost;
    while (cur !== undefined && cur.kind !== 'Module') {
      const parentId = cur.parent;
      if (parentId === null) break;
      cur = tree.getScope(parentId);
    }
    if (cur !== undefined && cur.kind === 'Module') return cur.id;
    return null;
  }

  // (1b) A field typed from a constructor assigned to it (`r = Outer();` in a
  // constructor body) must live on the CLASS scope — the assignment sits inside
  // the constructor's own Function scope, where `typeOfMemberOnClass` never
  // looks (#2807). Gated on the dedicated marker, never on
  // `@type-binding.constructor` at large, which also fires for genuine locals.
  if (decl['@type-binding.dart-field'] !== undefined) {
    return walkToScope(innermost, tree, 'Class');
  }

  // (2) Function/method/constructor names are visible in the enclosing scope.
  // So is a getter / setter name (`@dart.accessor`, DART-10): its Property
  // declaration lies inside the accessor's own synthesized Function scope, and
  // left there the Class scope would no longer own the name — a bare `cs` read
  // in a sibling member would climb past it to a same-named Module binding (the
  // hoisted return of `Other cs()` in another class) instead of stopping at
  // `this.cs`. A static accessor's declaration starts at `static`, before the
  // scope, so it already binds on the Class scope and is unaffected.
  if (
    decl['@declaration.function'] !== undefined ||
    decl['@declaration.method'] !== undefined ||
    decl['@declaration.constructor'] !== undefined ||
    decl['@dart.accessor'] !== undefined
  ) {
    if (innermost.kind === 'Function' && innermost.parent !== null) return innermost.parent;
  }

  return null;
}

export function dartImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  return innermost.kind === 'Module' ? innermost.id : null;
}

export function dartReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('this') ?? functionScope.typeBindings.get('super') ?? null;
}
