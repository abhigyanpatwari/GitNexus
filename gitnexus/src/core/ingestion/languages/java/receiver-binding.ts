/**
 * Synthesize `@type-binding.self` captures for Java instance contexts —
 * one for `this` (always on non-static methods, constructors and record
 * compact constructors inside a type declaration or an anonymous class
 * body) and optionally one for `super` (only on class methods when the
 * enclosing named class has a `superclass`).
 *
 * Instance initializer blocks and instance field initializers have no
 * method scope. They get a `this` binding only where a synthesized
 * implicit-`this` array receiver reads it (see
 * `implicit-array-receiver-captures.ts`).
 *
 * Mirrors `languages/csharp/receiver-binding.ts` in structure.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeToCapture,
  syntheticCapture,
  type JavaSynthesizedTypeIdentity,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import type { JavaInitializerReceiverContext } from './implicit-array-receiver-captures.js';

const TYPE_DECL_NODE_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
]);

const FUNCTION_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);

/** Walk up to the enclosing type: a named declaration, or the host of an
 *  anonymous class body (`new T() { ... }`, a bodied enum constant), reached
 *  from that body. Each ancestor's `parent` is read once, as before. */
function findEnclosingTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  let below = node;
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECL_NODE_TYPES.has(cur.type)) return cur;
    if (
      below.type === 'class_body' &&
      (cur.type === 'object_creation_expression' || cur.type === 'enum_constant')
    )
      return cur;
    below = cur;
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

/**
 * @param anonymousIdentity the synthesized identity of an anonymous class
 *   host; the caller shares one answer per host with the anonymous class
 *   declaration it emits, so a method adds no ancestor walk of its own.
 */
export function synthesizeJavaReceiverBinding(
  fnNode: SyntaxNode,
  anonymousIdentity: (host: SyntaxNode) => JavaSynthesizedTypeIdentity | undefined,
): CaptureMatch[] {
  if (!FUNCTION_NODE_TYPES.has(fnNode.type)) return [];
  if (isStaticMethod(fnNode)) return [];

  const enclosingType = findEnclosingTypeDeclaration(fnNode);
  if (enclosingType === null) return [];

  // Inside an anonymous class body `this` is the anonymous instance: its
  // synthesized class (`Outer$1`, the name its declaration is bound under),
  // whose own and inherited members apply, never the enclosing type's.
  // Without that name there is no `this` binding rather than a wrong one.
  const anonymous =
    enclosingType.type === 'object_creation_expression' || enclosingType.type === 'enum_constant';
  const enclosingName = anonymous
    ? (anonymousIdentity(enclosingType)?.name ?? null)
    : typeName(enclosingType);
  if (enclosingName === null) return [];

  // Anchor to the method body so the synthesized captures are inside
  // the function scope.
  const anchorNode = fnNode.childForFieldName('body');
  if (anchorNode === null) return [];

  const out: CaptureMatch[] = [];
  out.push(buildReceiverMatch(anchorNode, 'this', enclosingName));

  // `super` applies only to class/record methods with an explicit superclass.
  // An anonymous body's constructed type may be an interface (then `super`
  // is `Object`), so it gets none, rather than the enclosing type's.
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

/** A zero-width capture at `node`'s start: inside the scope that starts there,
 * yet never equal to that scope's range, so the binding is not hoisted out. */
function pointCapture(name: string, node: SyntaxNode, text: string): Capture {
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  return { name, range: { startLine, startCol, endLine: startLine, endCol: startCol }, text };
}

/**
 * `this` for instance initializer contexts that received an implicit-`this`
 * chain. An initializer block already has its own block scope. A field
 * initializer gets one over its value, so the binding reaches neither the
 * field's declaration nor a sibling member; a lambda value already has one.
 */
export function synthesizeJavaInitializerReceiverBindings(
  contexts: readonly JavaInitializerReceiverContext[],
): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  for (const { node, type } of contexts) {
    const enclosingName = typeName(type);
    if (enclosingName === null) continue;
    if (node.type !== 'block' && node.type !== 'lambda_expression')
      out.push({ '@scope.block': nodeToCapture('@scope.block', node) });
    out.push({
      '@type-binding.self': pointCapture('@type-binding.self', node, ''),
      '@type-binding.name': pointCapture('@type-binding.name', node, 'this'),
      '@type-binding.type': pointCapture('@type-binding.type', node, enclosingName),
    });
  }
  return out;
}
