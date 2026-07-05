/**
 * Synthesize `@type-binding.self` captures for Java instance methods —
 * one for `this` (always on non-static methods inside a type
 * declaration) and optionally one for `super` (only on class methods
 * when the enclosing class has a `superclass`).
 *
 * Mirrors `languages/csharp/receiver-binding.ts` in structure.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

const TYPE_DECL_NODE_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

const FUNCTION_NODE_TYPES = new Set(['method_declaration', 'constructor_declaration']);

/** Walk up to the enclosing type declaration. */
function findEnclosingTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECL_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

function typeName(typeNode: SyntaxNode): string | null {
  return typeNode.childForFieldName('name')?.text ?? null;
}

/** First superclass text. tree-sitter-java uses a `superclass` field
 *  containing a `superclass` node wrapping a `type_identifier`. */
function firstSuperclassText(typeNode: SyntaxNode): string | null {
  const superclass = typeNode.childForFieldName('superclass');
  if (superclass === null) return null;
  // The superclass node wraps the type_identifier
  for (let i = 0; i < superclass.namedChildCount; i++) {
    const child = superclass.namedChild(i);
    if (child !== null && (child.type === 'type_identifier' || child.type === 'generic_type')) {
      return child.text;
    }
  }
  return null;
}

/** Check if a method has the `static` modifier. In tree-sitter-java,
 *  modifiers are grouped under a `modifiers` named child with anonymous
 *  keyword tokens. */
function isStaticMethod(fnNode: SyntaxNode): boolean {
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const child = fnNode.namedChild(i);
    if (child !== null && child.type === 'modifiers') {
      for (let j = 0; j < child.childCount; j++) {
        const mod = child.child(j);
        if (mod !== null && mod.text.trim() === 'static') return true;
      }
    }
  }
  return false;
}

export function synthesizeJavaReceiverBinding(fnNode: SyntaxNode): CaptureMatch[] {
  if (!FUNCTION_NODE_TYPES.has(fnNode.type)) return [];
  if (isStaticMethod(fnNode)) return [];

  const enclosingType = findEnclosingTypeDeclaration(fnNode);
  if (enclosingType === null) return [];

  const enclosingName = typeName(enclosingType);
  if (enclosingName === null) return [];

  // Anchor to the method body so the synthesized captures are inside
  // the function scope.
  const anchorNode = fnNode.childForFieldName('body');
  if (anchorNode === null) return [];

  const out: CaptureMatch[] = [];
  out.push(buildReceiverMatch(anchorNode, 'this', enclosingName));

  // `super` applies only to class/record methods with an explicit superclass.
  if (enclosingType.type === 'class_declaration' || enclosingType.type === 'record_declaration') {
    const superText = firstSuperclassText(enclosingType);
    if (superText !== null) {
      out.push(buildReceiverMatch(anchorNode, 'super', superText));
    }
  }

  return out;
}

function buildReceiverMatch(anchorNode: SyntaxNode, name: string, typeText: string): CaptureMatch {
  const m: Record<string, Capture> = {
    '@type-binding.self': nodeToCapture('@type-binding.self', anchorNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, name),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, typeText),
  };
  return m;
}
