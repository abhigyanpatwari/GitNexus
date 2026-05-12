/**
 * Synthesize `@type-binding.self` captures for PHP instance methods —
 * one for `$this` (always on non-static methods inside a type
 * declaration) and optionally one for `parent` (only on class methods
 * when the enclosing class has an explicit `base_clause`).
 *
 * Mirrors `languages/csharp/receiver-binding.ts` in structure. PHP's
 * grammar doesn't give us a clean `.scm` pattern for "implicit receiver
 * on every instance method inside an enclosing type" because `$this` is
 * not a parameter — it's an implicit receiver. Synthesis in code is the
 * same approach C# uses for `this` / `base`.
 *
 * ## Known limitations
 *
 *   - **Trait `$this`**: for methods defined in a trait, `$this` is
 *     synthesized as a binding to the trait itself. The actual using-class
 *     type is not known at single-file parse time. V1 limitation —
 *     documented in `index.ts`.
 *   - **Anonymous classes**: skipped (no stable enclosing class name).
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

const TYPE_DECL_NODE_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

const FUNCTION_NODE_TYPES = new Set([
  'method_declaration',
  'function_definition',
  'anonymous_function',
  'arrow_function',
]);

/** Walk up to find the enclosing type declaration. */
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

/**
 * Return the base class name from a `base_clause` child of the class node.
 * `base_clause` contains a `qualified_name` or `name` child.
 */
function baseClauseText(typeNode: SyntaxNode): string | null {
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child === null || child.type !== 'base_clause') continue;
    const nameNode = child.firstNamedChild;
    if (nameNode === null) return null;
    // Take last segment of qualified name (e.g. \App\Models\BaseModel → BaseModel)
    const text = nameNode.text.trim();
    const segments = text.split('\\').filter(Boolean);
    return segments[segments.length - 1] ?? text;
  }
  return null;
}

/** Check whether this method has a `static_modifier` child. */
function isStaticMethod(fnNode: SyntaxNode): boolean {
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const child = fnNode.namedChild(i);
    if (child !== null && child.type === 'static_modifier') return true;
  }
  return false;
}

/**
 * Build zero, one, or two `@type-binding.self` matches for `fnNode`:
 *
 *  - Returns `[]` if the function is free (no enclosing type), static,
 *    or the enclosing type has no resolvable name.
 *  - Returns one match (`$this`) for non-static methods inside a
 *    class / trait / interface / enum body.
 *  - Returns two matches (`$this` + `parent`) only when the function
 *    lives in a `class_declaration` that has an explicit `base_clause`.
 *
 * The caller is responsible for guaranteeing
 * `FUNCTION_NODE_TYPES.has(fnNode.type)`.
 */
export function synthesizePhpReceiverBinding(fnNode: SyntaxNode): CaptureMatch[] {
  if (!FUNCTION_NODE_TYPES.has(fnNode.type)) return [];
  if (isStaticMethod(fnNode)) return [];

  const enclosingType = findEnclosingTypeDeclaration(fnNode);
  if (enclosingType === null) return [];

  // Anonymous class — skip (no stable name).
  if (enclosingType.type === 'anonymous_class_declaration') return [];

  const enclosingName = typeName(enclosingType);
  if (enclosingName === null) return [];

  // Anchor the synthesized captures to the method body (compound_statement)
  // so they land inside the function scope, not at the class scope.
  // For interface/abstract methods that have no body, skip.
  const bodyNode =
    fnNode.childForFieldName('body') ??
    // arrow_function: body is the expression after `=>`
    fnNode.childForFieldName('return_value');
  if (bodyNode === null) return [];

  const out: CaptureMatch[] = [];
  out.push(buildReceiverMatch(bodyNode, '$this', enclosingName));

  // `parent` applies only to class methods with an explicit base_clause.
  if (enclosingType.type === 'class_declaration') {
    const baseText = baseClauseText(enclosingType);
    if (baseText !== null) {
      out.push(buildReceiverMatch(bodyNode, 'parent', baseText));
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
