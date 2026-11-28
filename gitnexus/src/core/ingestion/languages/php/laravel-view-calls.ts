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
import { normalizeQualifiedName } from '../../utils/qualified-name.js';
import { buildUseAliasMap } from '../../route-extractors/laravel.js';

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
 * A name in dot-joined, lowercase form: `\Illuminate\Support\Facades\View`
 * → `illuminate.support.facades.view`. Lowercase because PHP function, class
 * and method names are case-insensitive.
 */
const normalize = (text: string): string => normalizeQualifiedName(text).toLowerCase();

/** `view()` or `\view()`; a namespaced `App\view()` is some other function. */
const isGlobalFunction = (node: SyntaxNode | null, name: string): boolean =>
  node !== null && normalize(node.text) === name;

/** Local class name (lowercase) → its imported class (normalized), from the file's `use` statements. */
type UseAliases = ReadonlyMap<string, string>;

/**
 * Whether `scope` names Laravel's facade `name` (`view`, `route`): its full
 * name `Illuminate\Support\Facades\View`, or a short name that the file
 * imports from there (or from the global `View` alias Laravel registers). A
 * short name with no import is taken as that global alias. Any other class,
 * such as `App\View`, is not the facade.
 */
const isFacade = (scope: SyntaxNode, name: string, aliases: UseAliases): boolean => {
  const facade = `illuminate.support.facades.${name}`;
  const scopeName = normalize(scope.text);
  if (scopeName.includes('.')) return scopeName === facade;
  const imported = aliases.get(scopeName);
  if (imported === undefined) return scopeName === name;
  return imported === facade || imported === name;
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
const classify = (
  node: SyntaxNode,
  aliases: UseAliases,
): { kind: LaravelViewCallKind; argIndex: number } | null => {
  switch (node.type) {
    case 'function_call_expression':
      return isGlobalFunction(node.childForFieldName('function'), 'view')
        ? { kind: 'helper', argIndex: 0 }
        : null;
    case 'scoped_call_expression': {
      const scope = node.childForFieldName('scope');
      const name = node.childForFieldName('name')?.text.toLowerCase();
      if (!scope) return null;
      if (name === 'make' && isFacade(scope, 'view', aliases)) {
        return { kind: 'facade', argIndex: 0 };
      }
      if (name === 'view' && isFacade(scope, 'route', aliases)) {
        return { kind: 'route', argIndex: 1 };
      }
      return null;
    }
    case 'member_call_expression': {
      // Only `response()->view(...)`: `->view()` on an arbitrary object is not
      // known to render a Blade template, so it is not guessed at.
      if (node.childForFieldName('name')?.text.toLowerCase() !== 'view') return null;
      const object = node.childForFieldName('object');
      if (object?.type !== 'function_call_expression') return null;
      return isGlobalFunction(object.childForFieldName('function'), 'response')
        ? { kind: 'response', argIndex: 0 }
        : null;
    }
    default:
      return null;
  }
};

/** Every view-render call in a PHP file, in source order. */
export const extractLaravelViewCalls = (tree: Parser.Tree): LaravelViewCall[] => {
  const calls: LaravelViewCall[] = [];
  const aliases: UseAliases = new Map(
    [...buildUseAliasMap(tree.rootNode)].map(([local, target]) => [
      local.toLowerCase(),
      target.toLowerCase(),
    ]),
  );
  const stack: SyntaxNode[] = [tree.rootNode];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const match = classify(node, aliases);
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
