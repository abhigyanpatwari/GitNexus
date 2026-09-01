/**
 * Python's `decoratorRouteHandlerName` provider hook.
 *
 * A Python route decorator (`@router.get("/x")`) is a `decorator` child of a
 * `decorated_definition`, which also holds the definition the decorator applies
 * to in its `definition` field. That makes the handler name available at
 * decorator-extraction time, which is what lets the routes phase stamp
 * `handlerSymbolId` and attach `HANDLES_ROUTE` to the function rather than only
 * to its file.
 *
 * Ownership is deliberately narrow: this reads the one grammar shape Python
 * actually produces and returns nothing for anything else. It does not walk
 * ancestors, so a route decorator that is not directly attached to a function
 * cannot borrow an enclosing definition's name, and a class-attached decorator
 * (`@router.get(...)` above `class K:`) yields nothing rather than a class name
 * — a class does not handle a request, and naming it would resolve
 * `handlerSymbolId` to the wrong symbol. Returning undefined is safe: the routes
 * phase already treats a missing name as "fall back to the file-level edge".
 *
 * Stacked decorators need no special handling — tree-sitter-python puts every
 * decorator in the run under the same `decorated_definition`, so each one's
 * immediate parent already carries the definition.
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
