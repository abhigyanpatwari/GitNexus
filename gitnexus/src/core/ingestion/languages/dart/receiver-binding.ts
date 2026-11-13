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
 *
 * The enclosing type declaration is never searched for from scratch: a closure
 * gets it from the capture walk, which carries it down the tree, and a declared
 * member looks it up through a per-file memo, so each AST node is climbed past
 * at most once per file however deep closures nest (#3912 review).
 */

import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import type { CaptureMatch } from 'gitnexus-shared';
import { dartMethodConfig } from '../../method-extractors/configs/dart.js';

/** Node types that give the members and closures inside them a `this`. */
export const DART_TYPE_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  'class_definition',
  'mixin_declaration',
  'extension_declaration',
  'extension_type_declaration',
  'enum_declaration',
]);

/**
 * Per-file memo for `findEnclosingTypeDeclaration`: node id → the nearest
 * enclosing type declaration of that node, or null when it has none (known
 * absence, so a top-level function's closures stop there too).
 */
export type DartEnclosingTypeMemo = Map<number, SyntaxNode | null>;

/** Ancestors the enclosing-type search has stepped onto (operation-count test hook). */
let ancestorVisits = 0;

/** Operation counts for the enclosing-type search, for the linearity test. */
export function getDartEnclosingTypeStats(): { ancestorVisits: number } {
  return { ancestorVisits };
}

export function resetDartEnclosingTypeStats(): void {
  ancestorVisits = 0;
}

/**
 * Walk up from a declaration node to its enclosing type declaration. The climb
 * stops at the first ancestor the memo already answers for and records the
 * answer for every node it passed, so a nested declaration reuses its outer
 * one's answer instead of climbing to the root again.
 */
function findEnclosingTypeDeclaration(
  node: SyntaxNode,
  memo: DartEnclosingTypeMemo,
): SyntaxNode | null {
  // A type declaration answers for what is inside it, not for itself.
  const passed: number[] = DART_TYPE_DECLARATION_TYPES.has(node.type) ? [] : [node.id];
  let found: SyntaxNode | null = null;
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    ancestorVisits++;
    const known = memo.get(cur.id);
    if (known !== undefined) {
      found = known;
      break;
    }
    if (DART_TYPE_DECLARATION_TYPES.has(cur.type)) {
      found = cur;
      break;
    }
    passed.push(cur.id);
    cur = cur.parent;
  }
  for (const id of passed) memo.set(id, found);
  return found;
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

function receiverBindings(enclosingType: SyntaxNode | null, bodyNode: SyntaxNode): CaptureMatch[] {
  if (enclosingType === null) return []; // top-level function — no receiver

  const typeName = enclosingTypeName(enclosingType);
  if (typeName === null) return [];

  const out: CaptureMatch[] = [buildReceiverMatch(bodyNode, 'this', typeName)];
  const superType = firstSuperType(enclosingType);
  if (superType !== null) out.push(buildReceiverMatch(bodyNode, 'super', superType));
  return out;
}

/**
 * A declared member (Pass A). `declNode` is the method declaration wrapper
 * (`method_signature` / `declaration` / top-level `function_signature`).
 * `bodyNode` is the resolved sibling `function_body` (the anchor for
 * Function-scope landing). `memo` is the file's enclosing-type memo.
 */
export function synthesizeDartReceiverBinding(
  declNode: SyntaxNode,
  bodyNode: SyntaxNode,
  memo: DartEnclosingTypeMemo,
): CaptureMatch[] {
  if (dartMethodConfig.isStatic(declNode)) return [];
  return receiverBindings(findEnclosingTypeDeclaration(declNode, memo), bodyNode);
}

/**
 * A closure or local function (Pass B), whose nearest enclosing type
 * declaration the capture walk carried down the tree (null: it has none).
 */
export function synthesizeDartReceiverBindingWithin(
  declNode: SyntaxNode,
  bodyNode: SyntaxNode,
  enclosingType: SyntaxNode | null,
): CaptureMatch[] {
  if (dartMethodConfig.isStatic(declNode)) return [];
  return receiverBindings(enclosingType, bodyNode);
}
