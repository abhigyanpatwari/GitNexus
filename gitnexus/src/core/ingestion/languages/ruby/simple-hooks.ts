import type {
  CaptureMatch,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  TypeRef,
  NodeLabel,
} from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { walkToScope } from '../typescript/simple-hooks.js';

export function rubyBindingScopeFor(
  decl: CaptureMatch,
  innermost: Scope,
  tree: ScopeTree,
): ScopeId | null {
  // Keep self typeBindings in the method's Function scope so
  // populateClassOwnedMembers can match Method defs to their receiver types.
  if (decl['@type-binding.self'] !== undefined) {
    return innermost.id;
  }
  // `@ivar = Foo.new` in `initialize` (or any method) declares a FIELD of the
  // enclosing class, so its type binding belongs on the Class scope — the only
  // place `typeOfMemberOnClass` reads it. Left on the method's own Function
  // scope it would be invisible to every other method (#2807).
  //
  // Gated on the marker that pattern emits, never on `@type-binding.constructor`
  // at large: that capture also fires for `x = Foo.new` locals, and hoisting
  // those to the class would leak a method local into every sibling method.
  if (decl['@type-binding.ivar-field'] !== undefined) {
    return walkToScope(innermost, tree, 'Class');
  }
  return null;
}

/**
 * Ruby `require` / `include` inside a function or class body should attach
 * at that scope, not module scope.
 */
export function rubyImportOwningScope(
  _imp: ParsedImport,
  innermost: Scope,
  _tree: ScopeTree,
): ScopeId | null {
  if (innermost.kind === 'Function' || innermost.kind === 'Class') {
    return innermost.id;
  }
  return null;
}

export function rubyReceiverBinding(functionScope: Scope): TypeRef | null {
  if (functionScope.kind !== 'Function') return null;
  return functionScope.typeBindings.get('self') ?? null;
}

/**
 * Reclassify top-level `def` as `'Method'` when it appears inside a
 * `class` or `module` body. Stand-alone defs remain `'Function'`.
 */
export function rubyFunctionDefinitionLabel(
  functionNode: SyntaxNode,
  defaultLabel: NodeLabel,
): NodeLabel {
  if (defaultLabel !== 'Function') return defaultLabel;
  let ancestor: SyntaxNode | null = functionNode.parent;
  while (ancestor) {
    if (ancestor.type === 'program') break;
    if (ancestor.type === 'class' || ancestor.type === 'module') {
      return 'Method';
    }
    ancestor = ancestor.parent;
  }
  return 'Function';
}
