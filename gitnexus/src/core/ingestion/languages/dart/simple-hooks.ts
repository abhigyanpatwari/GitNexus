/**
 * Small explicit Dart scope-resolution hooks:
 *
 *   - `dartBindingScopeFor` — (1) hoists `@type-binding.return` bindings to
 *     the Module scope so chain-follow + `propagateImportedReturnTypes` see
 *     them; (2) hoists function/method/constructor declaration NAMES to the
 *     enclosing parent scope. The second case is Dart-specific: because
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
import { walkToScope } from '../typescript/simple-hooks.js';

export function dartBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  // (1) Return-type bindings hoist to the Module scope.
  if (decl['@type-binding.return'] !== undefined) {
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
  if (
    decl['@declaration.function'] !== undefined ||
    decl['@declaration.method'] !== undefined ||
    decl['@declaration.constructor'] !== undefined
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
