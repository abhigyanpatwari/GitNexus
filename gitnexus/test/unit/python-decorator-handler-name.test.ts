/**
 * Pins Python's `decoratorRouteHandlerName` provider hook against real
 * tree-sitter-python trees.
 *
 * The hook feeds `ExtractedDecoratorRoute.handlerName`, which the routes phase
 * turns into `handlerSymbolId` and a definition-level `HANDLES_ROUTE` edge. Two
 * failure directions matter and both are asserted here:
 *
 *   • too little — a plain module function, a method, a stacked-decorator run,
 *     or an `async def` must all yield the decorated function's name, or every
 *     Flask/FastAPI handler silently degrades to a file-level edge;
 *   • too much — a class-attached route decorator must yield nothing. A class
 *     does not handle a request, and returning its name would resolve
 *     `handlerSymbolId` to the wrong symbol.
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { pythonDecoratorRouteHandlerName } from '../../src/core/ingestion/route-extractors/python-decorator-handler.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

const parser = new Parser();
parser.setLanguage(Python);

/** Every `decorator` node in `src`, in source order. */
function decorators(src: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const walk = (node: SyntaxNode): void => {
    if (node.type === 'decorator') found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(parser.parse(src).rootNode);
  return found;
}

/** Handler names the hook reports for each decorator in `src`. */
const handlerNames = (src: string): Array<string | undefined> =>
  decorators(src).map((node) => pythonDecoratorRouteHandlerName(node));

describe('pythonDecoratorRouteHandlerName', () => {
  it('names the module-level function a route decorator sits on', () => {
    expect(handlerNames('@router.get("/widgets")\ndef list_widgets(): pass\n')).toEqual([
      'list_widgets',
    ]);
  });

  it('names a method inside a class', () => {
    expect(
      handlerNames('class WidgetView:\n    @router.post("/widgets")\n    def create(self): pass\n'),
    ).toEqual(['create']);
  });

  it('names the same function for every decorator in a stacked run', () => {
    // tree-sitter-python puts all decorators of a run under one
    // `decorated_definition`, so no ancestor walk is needed to reach the
    // definition past the sibling decorator.
    expect(handlerNames('@router.get("/me")\n@requires_auth\ndef whoami(): pass\n')).toEqual([
      'whoami',
      'whoami',
    ]);
  });

  it('names an async handler (`async def` is still a function_definition)', () => {
    expect(handlerNames('@app.get("/health")\nasync def health(): pass\n')).toEqual(['health']);
  });

  it('returns undefined for a class-attached route decorator', () => {
    expect(handlerNames('@router.get("/widgets")\nclass WidgetResource: pass\n')).toEqual([
      undefined,
    ]);
  });

  it('does not climb out of a class body to borrow the enclosing class name', () => {
    // The decorator's parent here is the class body's `decorated_definition`
    // holding a class, not a function. An ancestor walk would have found
    // `Outer`; direct-shape ownership reports nothing.
    expect(handlerNames('class Outer:\n    @router.get("/x")\n    class Inner: pass\n')).toEqual([
      undefined,
    ]);
  });

  it('names the real def when a commented-out def precedes it', () => {
    // Python applies the decorator to the next real definition; the comment is
    // not a definition, so `real_handler` is the correct answer.
    expect(
      handlerNames('@router.get("/x")\n# def old_handler(): pass\ndef real_handler(): pass\n'),
    ).toEqual(['real_handler']);
  });

  it('returns undefined for a non-route decorator context with no decorated definition', () => {
    // A bare decorator with no following definition is an ERROR/partial parse;
    // the hook must not invent a name from whatever the parent happens to be.
    expect(handlerNames('@router.get("/x")\n')).toEqual([undefined]);
  });
});
