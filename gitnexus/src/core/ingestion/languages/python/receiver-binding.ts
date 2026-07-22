/**
 * Synthesize implicit receiver and constructor-assigned field type bindings
 * for methods.
 *
 * Tree-sitter can't easily express "the first parameter of a function
 * defined directly inside a class body" via a single static query.
 * Doing this in code keeps the embedded scope query declarative and
 * lets us encode the `@classmethod` / `@staticmethod` decorator
 * awareness that Python's runtime depends on.
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

/**
 * Synthesize class-scope field bindings for the common Python constructor
 * injection pattern:
 *
 *   def __init__(self, service: Service):
 *       self.service = service
 *
 * An explicit field annotation (`self.service: Service = ...`) is also
 * accepted and takes precedence over a parameter annotation. Deliberately do
 * not infer from arbitrary unannotated RHS expressions: the receiver resolver
 * needs a declared type, not a name-only guess.
 */
export function synthesizeConstructorFieldTypeBindings(fnNode: SyntaxNode): CaptureMatch[] {
  if (fnNode.childForFieldName('name')?.text !== '__init__') return [];
  if (findEnclosingClassDefinition(fnNode) === null) return [];
  if (hasDecorator(fnNode, 'staticmethod') || hasDecorator(fnNode, 'classmethod')) return [];

  const receiver = synthesizeReceiverTypeBinding(fnNode);
  const receiverName = receiver?.['@type-binding.self']?.text;
  if (receiverName === undefined) return [];

  const parameters = fnNode.childForFieldName('parameters');
  const body = fnNode.childForFieldName('body');
  if (parameters === null || body === null) return [];

  const parameterTypes = new Map<string, string>();
  for (let i = 0; i < parameters.namedChildCount; i++) {
    const parameter = parameters.namedChild(i);
    if (parameter === null) continue;
    const name = firstParameterName(parameter);
    const annotation = parameter.childForFieldName('type');
    if (name !== null && annotation !== null) parameterTypes.set(name, annotation.text);
  }

  type Candidate = { readonly match: CaptureMatch; readonly explicit: boolean };
  const candidates = new Map<string, Candidate>();

  const stack: SyntaxNode[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node !== body &&
      (node.type === 'function_definition' ||
        node.type === 'lambda' ||
        node.type === 'class_definition' ||
        node.type === 'if_statement' ||
        node.type === 'for_statement' ||
        node.type === 'while_statement' ||
        node.type === 'try_statement' ||
        node.type === 'match_statement')
    ) {
      continue;
    }

    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left?.type === 'attribute') {
        const object = left.childForFieldName('object');
        const field = left.childForFieldName('attribute');
        if (object?.type === 'identifier' && object.text === receiverName && field !== null) {
          const explicitType = node.childForFieldName('type');
          const parameterType =
            right?.type === 'identifier' ? parameterTypes.get(right.text) : undefined;
          const typeName = explicitType?.text ?? parameterType;
          if (typeName !== undefined) {
            const explicit = explicitType !== null;
            const existing = candidates.get(field.text);
            if (existing === undefined || explicit || !existing.explicit) {
              candidates.set(field.text, {
                explicit,
                match: {
                  '@type-binding.name': syntheticCapture('@type-binding.name', field, field.text),
                  '@type-binding.type': syntheticCapture(
                    '@type-binding.type',
                    explicitType ?? right ?? field,
                    typeName,
                  ),
                  ...(explicit
                    ? {}
                    : {
                        '@type-binding.parameter': syntheticCapture(
                          '@type-binding.parameter',
                          right ?? field,
                          '1',
                        ),
                      }),
                  '@type-binding.instance-field': syntheticCapture(
                    '@type-binding.instance-field',
                    node,
                    '1',
                  ),
                },
              });
            }
          }
        }
      }
    }

    // Push in reverse so the LIFO walk visits source order. That keeps Map
    // insertion order (and therefore emitted capture order) deterministic.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }

  return [...candidates.values()].map(({ match }) => match);
}
