/**
 * Synthesize `@type-binding.this` captures for TypeScript instance-like
 * methods.
 *
 * Tree-sitter can't cleanly express "the implicit `this` receiver of a
 * non-static member of a class / interface / abstract class" via a
 * static `.scm` pattern, so we walk up the AST in code — mirrors
 * Python's `self` / `cls` and C#'s `this` / `base` synthesis.
 *
 * Scope coverage:
 *
 *   - `method_definition` inside `class_declaration`,
 *     `abstract_class_declaration`, or `class_expression` → synthesize
 *     `this` → enclosing class name.
 *   - `method_signature` / `abstract_method_signature` inside
 *     `interface_declaration` or `abstract_class_declaration` →
 *     synthesize `this` → enclosing type's name (so interface method
 *     bodies' `this.x` chains resolve via the interface's field
 *     annotations).
 *   - `arrow_function` / `function_expression` that is a direct value
 *     of a `public_field_definition` (class field) — `m = () => {}` —
 *     synthesize `this` → enclosing class name. These capture `this`
 *     lexically; without synthesis, their body's `this.foo` wouldn't
 *     resolve.
 *
 * Not synthesized (intentionally):
 *
 *   - `static` methods / static fields. `this` in a static context
 *     refers to the class constructor, not an instance; we leave the
 *     binding empty and let chain resolution fall through to the
 *     class's static members lookup.
 *   - Regular `function_declaration` / `function_expression` at
 *     module level or in a non-class context. No enclosing type, no
 *     `this` semantics.
 *   - Arrow functions nested inside a method body. The scope-chain
 *     walk in `tsReceiverBinding` finds the outer method's `this`
 *     naturally, matching TS's lexical-this rule for arrow functions.
 *
 * Each synthesized match emits the anchor captures needed by
 * `interpretTsTypeBinding`:
 *
 *   `@type-binding.this`  (source discriminator — interpret maps to 'self')
 *   `@type-binding.name`  (the literal `'this'`)
 *   `@type-binding.type`  (the enclosing type's name)
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/** Node types that define a TypeScript "type with instance members". */
const TYPE_DECL_NODE_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'class_expression',
  'interface_declaration',
]);

/** Scope function nodes that could be a class method body. */
const CLASS_MEMBER_FUNCTION_TYPES = new Set([
  'method_definition',
  'method_signature',
  'abstract_method_signature',
]);

/** Function-like values that can back a class field (`m = () => {}`). */
const CLASS_FIELD_FUNCTION_TYPES = new Set(['arrow_function', 'function_expression']);

/**
 * Produce zero or one `CaptureMatch` synthesizing `this` for `fnNode`.
 *
 *   - `null` — function has no synthetic `this` (free / static /
 *     not-in-class / no name on enclosing type).
 *   - One match — anchor on the function body so the synthetic binding
 *     attaches to the function's scope (not the outer class scope).
 *
 * The caller is responsible for passing a `fnNode` whose type is one
 * of the scope function nodes the scope query emits.
 */
export function synthesizeTsReceiverBinding(fnNode: SyntaxNode): CaptureMatch | null {
  // Classify the function's role.
  const role = classifyFunctionRole(fnNode);
  if (role === null) return null;

  // Static methods / static fields don't have an instance `this`.
  if (isStaticMember(role.memberNode)) return null;

  // Find enclosing type declaration. Walking past function-like
  // boundaries is fine — nested local functions inside a method can
  // still reference outer `this` through the lexical chain, but we
  // only synthesize on the immediate function body. The resolver's
  // scope-chain walk reaches ancestor synthesized bindings for nested
  // arrow functions.
  const enclosingType = findEnclosingType(role.memberNode);
  if (enclosingType === null) return null;

  const typeName = getTypeDeclName(enclosingType);
  if (typeName === null) return null;

  // Anchor the synthetic capture on the function body so the binding
  // lands in the method's scope, not its parent type scope. Method
  // signatures in interfaces / abstract classes have no body — use
  // the method node itself as the anchor; scope-extractor attaches
  // it to the function scope created by the `@scope.function`
  // anchor at the same range.
  const anchorNode = fnNode.childForFieldName('body') ?? fnNode;

  return buildThisBinding(anchorNode, typeName);
}

interface FunctionRole {
  /** Node carrying the (possibly `static`) modifier. For method
   *  definitions this is `fnNode` itself; for arrow-bodied fields
   *  this is the `public_field_definition` parent. */
  readonly memberNode: SyntaxNode;
}

/**
 * Decide whether `fnNode` participates as a class member. Returns
 * `null` when the function is not structurally "a class instance
 * member" — e.g. a free function, a non-method arrow expression, an
 * arrow inside a method body (those inherit `this` via scope chain
 * lookup, no synthesis needed).
 */
function classifyFunctionRole(fnNode: SyntaxNode): FunctionRole | null {
  if (CLASS_MEMBER_FUNCTION_TYPES.has(fnNode.type)) {
    return { memberNode: fnNode };
  }
  if (CLASS_FIELD_FUNCTION_TYPES.has(fnNode.type)) {
    // `public_field_definition` represents a class field. Only when
    // the arrow/function-expression is a DIRECT value of a field do
    // we treat it as a class method with synthesized `this`.
    const parent = fnNode.parent;
    if (parent !== null && parent.type === 'public_field_definition') {
      const valueField = parent.childForFieldName('value');
      if (valueField !== null && valueField.startIndex === fnNode.startIndex) {
        return { memberNode: parent };
      }
    }
  }
  return null;
}

/** Class-body definitions carry an optional `accessibility_modifier` and
 *  optional `static` keyword as named children. The `static` token is
 *  usually a plain child of the member node — not a named field — so
 *  we scan children for a token whose text is exactly `static`. */
function isStaticMember(memberNode: SyntaxNode): boolean {
  for (let i = 0; i < memberNode.childCount; i++) {
    const c = memberNode.child(i);
    if (c === null) continue;
    // `static` can appear as an unnamed token or as a `readonly` /
    // `static` keyword node depending on grammar version; check text.
    if (c.text === 'static') return true;
  }
  return false;
}

function findEnclosingType(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECL_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Return the declared name of a class / interface / abstract-class.
 *  `class_expression` ( `const X = class { … }` ) may lack a name —
 *  in that case we return `null` and the caller skips synthesis (the
 *  outer variable's name is the usable handle, but wiring it would
 *  require a separate walk; defer to a follow-up). */
function getTypeDeclName(typeNode: SyntaxNode): string | null {
  const nameField = typeNode.childForFieldName('name');
  if (nameField === null) return null;
  return nameField.text;
}

function buildThisBinding(anchorNode: SyntaxNode, typeText: string): CaptureMatch {
  const m: Record<string, Capture> = {
    '@type-binding.this': nodeToCapture('@type-binding.this', anchorNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, 'this'),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, typeText),
  };
  return m;
}
