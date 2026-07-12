/**
 * Synthesize implicit `this` / `super` type-bindings for Solidity
 * contract methods — tree-sitter cannot express the implicit receiver
 * via a static query. Mirror of `languages/dart/receiver-binding.ts`.
 *
 * Anchors on `function_body` so bindings land in the Function scope
 * (not the enclosing Class scope). Top-level free functions get none.
 */

import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import type { CaptureMatch } from 'gitnexus-shared';

const TYPE_DECL_TYPES = new Set([
  'contract_declaration',
  'interface_declaration',
  'library_declaration',
]);

const FUNCTION_LIKE_TYPES = new Set([
  'function_definition',
  'modifier_definition',
  'constructor_definition',
  'fallback_receive_definition',
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

/** Bare type name for a contract / interface / library declaration. */
function enclosingTypeName(typeNode: SyntaxNode): string | null {
  const nameNode = typeNode.childForFieldName('name');
  return nameNode !== null ? nameNode.text : null;
}

/**
 * First `is Base` ancestor type name (for `super`).
 * Uses the same `ancestor` field as heritage synthesis in captures.ts.
 */
function firstSuperType(typeNode: SyntaxNode): string | null {
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (!child || child.type !== 'inheritance_specifier') continue;
    const ancestor = child.childForFieldName('ancestor');
    if (!ancestor) continue;
    const nameNode =
      ancestor.type === 'identifier' ? ancestor : (ancestor.lastNamedChild ?? ancestor);
    const text = nameNode.text.trim();
    if (text) return text;
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

/** Resolve the `function_body` child used as the Function-scope anchor. */
export function findSolidityFunctionBody(declNode: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child?.type === 'function_body') return child;
  }
  return declNode.childForFieldName('body');
}

/**
 * Emit `this` (+ `super` when the contract inherits) type-bindings for
 * one function-like declaration. No-op for free functions / bodyless decls.
 */
export function synthesizeSolidityReceiverBinding(declNode: SyntaxNode): CaptureMatch[] {
  if (!FUNCTION_LIKE_TYPES.has(declNode.type)) return [];

  const bodyNode = findSolidityFunctionBody(declNode);
  if (bodyNode === null) return [];

  const enclosingType = findEnclosingTypeDeclaration(declNode);
  if (enclosingType === null) return [];

  const typeName = enclosingTypeName(enclosingType);
  if (typeName === null) return [];

  const out: CaptureMatch[] = [buildReceiverMatch(bodyNode, 'this', typeName)];
  const superType = firstSuperType(enclosingType);
  if (superType !== null) {
    out.push(buildReceiverMatch(bodyNode, 'super', superType));
  }
  return out;
}

/** Walk the file and synthesize receivers for every function-like with a body. */
export function synthesizeAllSolidityReceiverBindings(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (FUNCTION_LIKE_TYPES.has(node.type)) {
      for (const cm of synthesizeSolidityReceiverBinding(node)) out.push(cm);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return out;
}
