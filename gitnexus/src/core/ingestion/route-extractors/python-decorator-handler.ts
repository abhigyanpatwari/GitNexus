/**
 * Return the function name attached to a Python decorator's immediate
 * `decorated_definition`; reject every other shape rather than climbing.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';

export function pythonDecoratorRouteHandlerName(decoratorNode: SyntaxNode): string | undefined {
  const decorated = decoratorNode.parent;
  if (decorated === null || decorated.type !== 'decorated_definition') return undefined;

  // `async def` is still a `function_definition` in tree-sitter-python (the
  // `async` keyword is an anonymous child), so async handlers need no branch.
  const definition = decorated.childForFieldName('definition');
  if (!definition || definition.type !== 'function_definition') return undefined;

  const name = definition.childForFieldName('name')?.text;
  return name !== undefined && name.length > 0 ? name : undefined;
}
