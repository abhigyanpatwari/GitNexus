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
import { walkToScope } from '../../utils/scope-tree-walk.js';

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
  // A plain Ruby `def` creates a method on the enclosing class/module (or
  // Object at top level), even when it appears textually inside another
  // method. The provider proves this from the AST before emitting either a
  // function or a reclassified method declaration; singleton methods and
  // lambda/proc bindings never carry this marker.
  if (decl['@declaration.lexical-method'] !== undefined) {
    let cur: Scope | undefined = innermost;
    while (cur !== undefined && cur.kind !== 'Class' && cur.kind !== 'Module') {
      // A block's receiver can rebind Ruby's default definee (`class_eval`,
      // `Class.new`, or a user helper forwarding the block). Its target is not
      // recoverable from lexical scope alone, so do not project a method across
      // this boundary onto an unrelated enclosing class/module.
      if (cur.kind === 'Block') return null;
      const parentId: ScopeId | null = cur.parent ?? null;
      if (parentId === null) break;
      cur = tree.getScope(parentId);
    }
    if (cur !== undefined && (cur.kind === 'Class' || cur.kind === 'Module')) return cur.id;
  }
  // `@ivar = Foo.new` in `initialize` (or any method) declares a FIELD of the
  // enclosing class, so its type binding belongs on the Class scope — the only
  // place `typeOfMemberOnClass` reads it. Left on the method's own Function
  // scope it would be invisible to every other method (#2807).
  //
  // Gated on the marker that pattern emits, never on `@type-binding.constructor`
  // at large: that capture also fires for `x = Foo.new` locals, and hoisting
  // those to the class would leak a method local into every sibling method.
  //
  // Reaching this hook already means the write is an INSTANCE write. `Capture`
  // carries only name/range/text — no AST node — so this hook cannot ask whose
  // `self` owns the ivar; `isRubyInstanceIvarWrite` (captures.ts) answers that
  // upstream and discards the binding entirely whenever `self` is anything but
  // an instance of the enclosing lexical class — the class object itself
  // (`def self.x`, `class << self`, the class body), or whatever object a block
  // receiver rebinds it to (`class_eval`, `Class.new`, `instance_eval`, …).
  // None of those reach an instance, so none may be published as its field.
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
