/**
 * Synthesize `@type-binding.self` / `@type-binding.cls` captures for
 * methods.
 *
 * Tree-sitter can't easily express "the first parameter of a function
 * defined directly inside a class body" via a single static query.
 * Doing this in code keeps the `.scm` file declarative and lets us
 * encode the `@classmethod` / `@staticmethod` decorator awareness that
 * Python's runtime depends on.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/** Walk up to the enclosing `class_definition`, ignoring the immediate
 *  `decorated_definition` wrapper. Returns `null` when the function is
 *  free, lambda-bodied, or nested inside another function. */
function findEnclosingClassDefinition(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (cur.type === 'class_definition') return cur;
    if (cur.type === 'function_definition') return null;
    cur = cur.parent;
  }
  return null;
}

function classDefinitionName(classNode: SyntaxNode): string | null {
  return classNode.childForFieldName('name')?.text ?? null;
}

/** Does the function carry a `@<decoratorName>` decorator? Matches both
 *  bare `@classmethod` and module-qualified `@functools.classmethod`. */
function hasDecorator(fnNode: SyntaxNode, decoratorName: string): boolean {
  const parent = fnNode.parent;
  if (parent === null || parent.type !== 'decorated_definition') return false;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child === null || child.type !== 'decorator') continue;
    const text = child.text.replace(/^@/, '').split('(')[0]!.trim();
    const tail = text.split('.').pop();
    if (tail === decoratorName) return true;
  }
  return false;
}

function firstNamedParameter(parameters: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < parameters.namedChildCount; i++) {
    const child = parameters.namedChild(i);
    if (child === null) continue;
    // Skip `*` / `/` markers.
    if (child.type === 'positional_separator' || child.type === 'keyword_separator') continue;
    return child;
  }
  return null;
}

function firstParameterName(param: SyntaxNode): string | null {
  if (param.type === 'identifier') return param.text;
  // typed_parameter / default_parameter / typed_default_parameter:
  // first child holds the identifier / pattern.
  const ident = param.childForFieldName('name') ?? findIdentifierChild(param);
  return ident?.text ?? null;
}

function findIdentifierChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === 'identifier') return child;
  }
  return null;
}

/**
 * Build a `@type-binding.self` (instance method) or `@type-binding.cls`
 * (`@classmethod`) match for `fnNode`, or `null` if `fnNode` is not a
 * method, is `@staticmethod`, or has no parameters.
 *
 * The caller is responsible for guaranteeing `fnNode.type ===
 * 'function_definition'`.
 */
export function synthesizeReceiverTypeBinding(fnNode: SyntaxNode): CaptureMatch | null {
  const enclosingClass = findEnclosingClassDefinition(fnNode);
  if (enclosingClass === null) return null;

  // Skip @staticmethod-decorated methods (no implicit receiver).
  if (hasDecorator(fnNode, 'staticmethod')) return null;
  const isClassmethod = hasDecorator(fnNode, 'classmethod');

  const params = fnNode.childForFieldName('parameters');
  if (params === null) return null;
  const first = firstNamedParameter(params);
  if (first === null) return null;

  const className = classDefinitionName(enclosingClass);
  if (className === null) return null;

  const firstName = firstParameterName(first);
  if (firstName === null) return null;

  // Receiver convention: instance methods get `self`, classmethods get `cls`.
  // We trust the AST literal name (Python convention is strict in practice).
  if (isClassmethod) {
    return {
      '@type-binding.cls': nodeToCapture('@type-binding.cls', first),
      '@type-binding.name': syntheticCapture('@type-binding.name', first, firstName),
      '@type-binding.type': syntheticCapture('@type-binding.type', first, className),
    };
  }
  return {
    '@type-binding.self': nodeToCapture('@type-binding.self', first),
    '@type-binding.name': syntheticCapture('@type-binding.name', first, firstName),
    '@type-binding.type': syntheticCapture('@type-binding.type', first, className),
  };
}
