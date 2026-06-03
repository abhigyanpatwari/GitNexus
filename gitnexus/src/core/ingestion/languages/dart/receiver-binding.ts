/**
 * Synthesize the implicit `this` (and `super`) receiver type-binding for a
 * Dart instance method — tree-sitter can't express the implicit receiver via
 * a static query pattern. Mirror of `languages/swift/receiver-binding.ts`,
 * adapted for Dart's grammar:
 *
 *   - The receiver name is `this` (Swift's `self`); `super` is the
 *     superclass receiver.
 *   - Dart's `function_signature`/`function_body` are SIBLINGS (not a
 *     `body:` field), so the caller passes the resolved `function_body`
 *     node explicitly as the anchor — anchoring the binding inside the body
 *     guarantees it lands in the (synthesized) Function scope, not the
 *     enclosing Class scope.
 *   - Static methods (`dartMethodConfig.isStatic`) and bodyless declarations
 *     get no receiver binding.
 */

import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { dartMethodConfig } from '../../method-extractors/configs/dart.js';

const TYPE_DECL_TYPES = new Set([
  'class_definition',
  'mixin_declaration',
  'extension_declaration',
  'enum_declaration',
]);

/** Walk up from a method declaration node to its enclosing type declaration. */
function findEnclosingTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECL_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** The bare type name for a type declaration (`class Foo` → `Foo`). */
function enclosingTypeName(typeNode: SyntaxNode): string | null {
  if (typeNode.type === 'mixin_declaration') {
    // mixin has no `name:` field — first identifier child is the name.
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const c = typeNode.namedChild(i);
      if (c !== null && c.type === 'identifier') return c.text;
    }
    return null;
  }
  const nameNode = typeNode.childForFieldName('name');
  return nameNode !== null ? nameNode.text : null;
}

/** The first `extends` superclass type name, if any (for `super`). */
function firstSuperType(typeNode: SyntaxNode): string | null {
  const superclass = typeNode.childForFieldName('superclass');
  if (superclass === null) return null;
  for (let i = 0; i < superclass.namedChildCount; i++) {
    const c = superclass.namedChild(i);
    if (c !== null && c.type === 'type_identifier') return c.text;
  }
  return null;
}

function buildReceiverMatch(anchor: SyntaxNode, name: string, typeText: string): CaptureMatch {
  return {
    '@type-binding.self': nodeToCapture('@type-binding.self', anchor),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchor, name),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchor, typeText),
  };
}

/**
 * `declNode` is the method declaration wrapper (`method_signature` /
 * `declaration` / top-level `function_signature`). `bodyNode` is the
 * resolved sibling `function_body` (the anchor for Function-scope landing).
 */
export function synthesizeDartReceiverBinding(
  declNode: SyntaxNode,
  bodyNode: SyntaxNode,
): CaptureMatch[] {
  if (dartMethodConfig.isStatic(declNode)) return [];

  const enclosingType = findEnclosingTypeDeclaration(declNode);
  if (enclosingType === null) return []; // top-level function — no receiver

  const typeName = enclosingTypeName(enclosingType);
  if (typeName === null) return [];

  const out: CaptureMatch[] = [buildReceiverMatch(bodyNode, 'this', typeName)];
  const superType = firstSuperType(enclosingType);
  if (superType !== null) out.push(buildReceiverMatch(bodyNode, 'super', superType));
  return out;
}
