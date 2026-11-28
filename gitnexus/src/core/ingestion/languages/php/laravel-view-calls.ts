/**
 * Laravel view-render call sites.
 *
 * Finds the PHP calls that render a Blade view by name, so a later step can
 * link the callable that holds each call to the template it renders:
 *
 *   view('posts.show', $data)          \view('posts.show')
 *   View::make('posts.show')           response()->view('errors.404', [], 404)
 *   Route::view('/welcome', 'welcome')
 *
 * Only a plain string literal is accepted as the view name. A name built at
 * runtime (`$view`, `"{$prefix}.nav"`, `'a' . $b`), a package view
 * (`mail::message`), and a named argument are skipped rather than guessed,
 * matching the Blade processor's rule for view-to-view links.
 */

import type Parser from 'tree-sitter';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

export type LaravelViewCallKind = 'helper' | 'facade' | 'response' | 'route';

export interface LaravelViewCall {
  /** Dotted view name as written, e.g. `posts.show`. */
  viewName: string;
  /** 0-based line of the call, as tree-sitter and the graph store lines. */
  lineNumber: number;
  /** Which call form named the view. */
  kind: LaravelViewCallKind;
  /** The call expression, so the caller can attribute it to its enclosing callable. */
  node: SyntaxNode;
}

/** Letters, digits, `_`, `-`, `.` and `/` only: rejects `namespace::name` and anything dynamic. */
const STATIC_VIEW_NAME_RE = /^[\w\-./]+$/;

/**
 * `\Illuminate\Support\Facades\View` → `view`; `\VIEW` → `view`. Lowercased
 * because PHP function, class and method names are case-insensitive.
 */
const lastSegment = (text: string): string => {
  const index = text.lastIndexOf('\\');
  return (index === -1 ? text : text.slice(index + 1)).toLowerCase();
};

/** The positional arguments of a call, or null when any argument is named or unpacked. */
const positionalArguments = (call: SyntaxNode): SyntaxNode[] | null => {
  const args = call.childForFieldName('arguments');
  if (!args) return null;
  const values: SyntaxNode[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== 'argument') continue;
    // `view(view: 'x')` or `view(...$args)`: the position no longer says which value is the view.
    if (arg.childForFieldName('name') || arg.children.some((c) => c.type === '...')) return null;
    const value = arg.namedChildren[0];
    if (!value) return null;
    values.push(value);
  }
  return values;
};

/**
 * The text of a string literal with no interpolation, or null. `"{$x}.nav"`
 * has a variable child, and `'a' . $b` is a binary expression, so both fail.
 */
const staticString = (node: SyntaxNode | undefined): string | null => {
  if (!node || (node.type !== 'string' && node.type !== 'encapsed_string')) return null;
  const parts = node.namedChildren;
  if (parts.length === 0) return '';
  if (parts.length !== 1 || parts[0].type !== 'string_content') return null;
  return parts[0].text;
};

/** Which argument names the view for this call, and what kind of call it is. */
const classify = (node: SyntaxNode): { kind: LaravelViewCallKind; argIndex: number } | null => {
  switch (node.type) {
    case 'function_call_expression': {
      const fn = node.childForFieldName('function');
      return fn && lastSegment(fn.text) === 'view' ? { kind: 'helper', argIndex: 0 } : null;
    }
    case 'scoped_call_expression': {
      const scope = node.childForFieldName('scope');
      const name = node.childForFieldName('name')?.text.toLowerCase();
      if (!scope) return null;
      const owner = lastSegment(scope.text);
      if (owner === 'view' && name === 'make') return { kind: 'facade', argIndex: 0 };
      if (owner === 'route' && name === 'view') return { kind: 'route', argIndex: 1 };
      return null;
    }
    case 'member_call_expression': {
      // Only `response()->view(...)`: `->view()` on an arbitrary object is not
      // known to render a Blade template, so it is not guessed at.
      if (node.childForFieldName('name')?.text.toLowerCase() !== 'view') return null;
      const object = node.childForFieldName('object');
      if (object?.type !== 'function_call_expression') return null;
      const fn = object.childForFieldName('function');
      return fn && lastSegment(fn.text) === 'response' ? { kind: 'response', argIndex: 0 } : null;
    }
    default:
      return null;
  }
};

/** Every view-render call in a PHP file, in source order. */
export const extractLaravelViewCalls = (tree: Parser.Tree): LaravelViewCall[] => {
  const calls: LaravelViewCall[] = [];
  const stack: SyntaxNode[] = [tree.rootNode];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const match = classify(node);
    if (match) {
      const viewName = staticString(positionalArguments(node)?.[match.argIndex]);
      if (viewName && STATIC_VIEW_NAME_RE.test(viewName)) {
        calls.push({ viewName, lineNumber: node.startPosition.row, kind: match.kind, node });
      }
    }
    // Push in reverse so children are visited first-to-last.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }

  return calls;
};
