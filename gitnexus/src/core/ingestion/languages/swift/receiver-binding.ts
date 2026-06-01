/**
 * Synthesize `@type-binding.self` captures for Swift instance methods —
 * one for `self` (always on non-static methods inside a type body) and
 * optionally one for `super` (only on class methods when the enclosing
 * class declares a superclass).
 *
 * Mirrors `languages/csharp/receiver-binding.ts`. tree-sitter can't
 * express "the implicit receiver of a non-static member of a
 * class/struct/extension/protocol" via a static `.scm` pattern because
 * the receiver isn't a parameter — it's implicit. Synthesis in code is
 * the same approach C#/Python use for `this`/`self`.
 *
 * Swift AST facts (tree-sitter-swift 0.7.1, verified):
 *   - class / struct / extension all parse to `class_declaration`. For
 *     class/struct the `name:` field is `(type_identifier)`; for an
 *     extension it is `(user_type (type_identifier))` wrapping the
 *     EXTENDED type — so `self` in an extension binds to the extended
 *     type, which is exactly what we want for method dispatch.
 *   - `protocol_declaration` has a `(type_identifier)` name.
 *   - the method body is the `body:` field (`function_body`); a bodyless
 *     `protocol_function_declaration` has no function scope to anchor to.
 *   - a superclass / conformance is an `(inheritance_specifier
 *     inherits_from: (user_type (type_identifier)))` child of the
 *     class_declaration.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { swiftQualifiedBaseTail } from './base-type.js';
import { swiftMethodConfig } from '../../method-extractors/configs/swift.js';

const TYPE_DECL_NODE_TYPES = new Set(['class_declaration', 'protocol_declaration']);

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'init_declaration',
  'deinit_declaration',
]);

/** Walk up to the enclosing type declaration (class/struct/extension/
 *  protocol). Nested local functions still see `self` from the enclosing
 *  type, so don't stop at function-like nodes. */
function findEnclosingTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECL_NODE_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Bare type name of the enclosing type. class/struct → type_identifier
 *  text; extension → the wrapped user_type's identifier text; protocol →
 *  type_identifier text. */
function enclosingTypeName(typeNode: SyntaxNode): string | null {
  const nameNode = typeNode.childForFieldName('name');
  if (nameNode === null) return null;
  if (nameNode.type === 'user_type') {
    // extension Foo { } → name is (user_type (type_identifier)).
    // extension Foo.Bar { } → (user_type (type_identifier Foo)
    // (type_identifier Bar)); the extended type — and therefore `self` —
    // is the TRAILING identifier `Bar` (lastNamedChild), not `Foo`. For a
    // single identifier first === last, so this is unchanged.
    const inner = nameNode.lastNamedChild;
    return inner?.text ?? nameNode.text;
  }
  return nameNode.text;
}

/** Is this declaration a `class` (vs `struct`/`extension`)? Only classes
 *  have a meaningful `super`. Detected by the leading keyword token —
 *  class/struct/extension share the `class_declaration` node type. */
function isClassKeyword(typeNode: SyntaxNode): boolean {
  for (let i = 0; i < typeNode.childCount; i++) {
    const child = typeNode.child(i);
    if (child !== null && !child.isNamed) {
      const t = child.text.trim();
      if (t === 'class') return true;
      if (t === 'struct' || t === 'extension' || t === 'enum' || t === 'actor') return false;
    }
  }
  return false;
}

/** First inherited type (superclass or first protocol) as raw text, or
 *  null. For a class the first `inheritance_specifier` is conventionally
 *  the superclass — `super.x()` only compiles when that is true. For a
 *  `user_type` base the name is its trailing `type_identifier` segment (see
 *  `swiftQualifiedBaseTail`), falling back to the raw node text when there is
 *  no `type_identifier` child. */
function firstInheritedType(typeNode: SyntaxNode): string | null {
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child === null || child.type !== 'inheritance_specifier') continue;
    const inheritsFrom = child.childForFieldName('inherits_from') ?? child.firstNamedChild;
    if (inheritsFrom === null) return null;
    if (inheritsFrom.type === 'user_type') {
      return swiftQualifiedBaseTail(inheritsFrom)?.text ?? inheritsFrom.text;
    }
    return inheritsFrom.text;
  }
  return null;
}

/** A Swift type method (`static func` OR `class func`) has no `self`
 *  instance receiver. Delegate to `swiftMethodConfig.isStatic`, which is
 *  the single source of truth: `static func` emits the modifier under a
 *  `modifiers > property_modifier` wrapper, but `class func` emits a BARE
 *  anonymous `class` token directly under `function_declaration` (verified,
 *  tree-sitter-swift 0.7.1). `swiftMethodConfig.isStatic` covers both via
 *  `hasKeyword(node, 'static'|'class')` (scans direct children) and
 *  `hasModifier(...)` — so reusing it avoids re-deriving the same scan and
 *  fixes the prior `modifiers`-only check that missed `class func`. */
function isStaticMethod(fnNode: SyntaxNode): boolean {
  return swiftMethodConfig.isStatic(fnNode);
}

/**
 * Build zero, one, or two `@type-binding.self` matches for `fnNode`:
 *  - `null`/`[]` if the function is free (no enclosing type), static, or
 *    the enclosing type has no resolvable name, or the function is
 *    bodyless (no scope to anchor to).
 *  - one match (`self`) for instance methods of a class/struct/extension/
 *    protocol.
 *  - two matches (`self` + `super`) only when the function lives in a
 *    `class` (keyword) declaration with a declared superclass.
 *
 * Caller must guarantee `FUNCTION_NODE_TYPES.has(fnNode.type)`.
 */
export function synthesizeSwiftReceiverBinding(fnNode: SyntaxNode): CaptureMatch[] {
  if (!FUNCTION_NODE_TYPES.has(fnNode.type)) return [];
  if (isStaticMethod(fnNode)) return [];

  const enclosingType = findEnclosingTypeDeclaration(fnNode);
  if (enclosingType === null) return [];

  const enclosingName = enclosingTypeName(enclosingType);
  if (enclosingName === null) return [];

  // Anchor inside the function scope. `body:` is the function_body; its
  // range is guaranteed inside the function scope (unlike the method's
  // start position, which maps to the enclosing type scope via
  // positionIndex). Bodyless declarations have no function scope.
  const anchorNode = fnNode.childForFieldName('body');
  if (anchorNode === null) return [];

  const out: CaptureMatch[] = [buildReceiverMatch(anchorNode, 'self', enclosingName)];

  // `super` only for class methods with a declared superclass.
  if (isClassKeyword(enclosingType)) {
    const superType = firstInheritedType(enclosingType);
    if (superType !== null) {
      out.push(buildReceiverMatch(anchorNode, 'super', superType));
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
