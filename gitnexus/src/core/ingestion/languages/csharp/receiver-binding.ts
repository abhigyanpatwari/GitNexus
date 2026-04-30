/**
 * Synthesize `@type-binding.self` captures for C# instance methods —
 * one for `this` (always on non-static methods inside a type
 * declaration) and optionally one for `base` (only on class methods
 * when the enclosing class has an explicit base in its `base_list`).
 *
 * Mirrors `languages/python/receiver-binding.ts` in structure. The
 * tree-sitter-c-sharp grammar doesn't give us a clean `.scm` pattern
 * for "this-receiver on every instance method inside an enclosing
 * type" because the binding isn't a parameter — it's an implicit
 * receiver. Synthesis in code is the same approach Python uses for
 * `self` / `cls`.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

const TYPE_DECL_NODE_TYPES = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
]);

const FUNCTION_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
]);

/** Walk up to the enclosing type declaration, stopping at any other
 *  function-like node (nested local functions shouldn't leak `this`
 *  from an outer class to an inner closure). */
function findEnclosingTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (TYPE_DECL_NODE_TYPES.has(cur.type)) return cur;
    // A local function nested inside another method still sees `this`
    // from the enclosing class — don't break on function-like nodes.
    cur = cur.parent;
  }
  return null;
}

function typeName(typeNode: SyntaxNode): string | null {
  return typeNode.childForFieldName('name')?.text ?? null;
}

/** First entry in the type's `base_list`, read as raw text. C# allows
 *  generic and qualified bases (`Foo<T>`, `N.M.Base`); we keep the raw
 *  form so downstream interpret layer can strip generics/qualifiers
 *  the same way as other type-binding captures. Returns null when the
 *  type has no base (or an empty base_list). */
function firstBaseText(typeNode: SyntaxNode): string | null {
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child === null || child.type !== 'base_list') continue;
    const firstBase = child.namedChild(0);
    if (firstBase === null) return null;
    return firstBase.text;
  }
  return null;
}

function isStaticMethod(fnNode: SyntaxNode): boolean {
  // A `static` modifier appears as a named `modifier` child whose text
  // is exactly "static". collectModifierTexts in field-extractors
  // handles this, but duplicating the tiny scan here keeps the
  // receiver-binding module dependency-free.
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const child = fnNode.namedChild(i);
    if (child !== null && child.type === 'modifier' && child.text.trim() === 'static') return true;
  }
  return false;
}

/**
 * Build zero, one, or two `@type-binding.self` matches for `fnNode`:
 *
 *  - Returns `null` if the function is free (no enclosing type),
 *    static, or the enclosing type has no resolvable name.
 *  - Returns one match (`this`) for non-static methods inside a
 *    class/struct/record/interface.
 *  - Returns two matches (`this` + `base`) only when the function
 *    lives in a `class_declaration` (or `record_declaration`) that has
 *    at least one base entry. Structs cannot inherit classes;
 *    interfaces cannot call `base.X`.
 *
 *  The caller is responsible for guaranteeing
 *  `FUNCTION_NODE_TYPES.has(fnNode.type)`.
 */
export function synthesizeCsharpReceiverBinding(fnNode: SyntaxNode): CaptureMatch[] {
  if (!FUNCTION_NODE_TYPES.has(fnNode.type)) return [];
  if (isStaticMethod(fnNode)) return [];

  const enclosingType = findEnclosingTypeDeclaration(fnNode);
  if (enclosingType === null) return [];

  const enclosingName = typeName(enclosingType);
  if (enclosingName === null) return [];

  // Anchor the synthesized captures to a node clearly *inside* the
  // function's scope (not at the method's start position, which maps
  // to the enclosing class scope via positionIndex). The method's
  // `body` field is the block statement — its range is guaranteed to
  // be inside the function scope. If the method has no body (interface
  // declaration, `abstract`), skip — there's no function scope to
  // attach the binding to.
  const anchorNode = fnNode.childForFieldName('body');
  if (anchorNode === null) return [];

  const out: CaptureMatch[] = [];
  out.push(buildReceiverMatch(anchorNode, 'this', enclosingName));

  // `base` applies only to class / record methods with an explicit
  // base class. `struct` can't inherit a class; `interface` can't
  // call `base.X`. The first entry of `base_list` is the base class
  // (interfaces follow); we can't statically distinguish the two here,
  // but `base.X` only compiles when the first entry IS a class, so we
  // trust the source — if the user wrote `base.X` in a class with
  // interface-only bases, their code wouldn't compile anyway.
  if (enclosingType.type === 'class_declaration' || enclosingType.type === 'record_declaration') {
    const baseText = firstBaseText(enclosingType);
    if (baseText !== null) {
      out.push(buildReceiverMatch(anchorNode, 'base', baseText));
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
