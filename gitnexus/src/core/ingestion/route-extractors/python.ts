/**
 * FastAPI / Starlette route extractor (Issues #79, #5, #78)
 *
 * Parses Python source code via tree-sitter (Python grammar) and emits
 * `ExtractedRoute` records for HTTP route decorators:
 *
 *   @app.get("/users")
 *   @app.post("/users")
 *   @router.delete("/users/{id}")
 *   ...
 *
 * Any receiver (`app`, `router`, `api_router`, etc.) is accepted. The
 * method name MUST be one of the standard FastAPI HTTP verbs.
 *
 * Non-route decorators (`@staticmethod`, `@app.exception_handler`,
 * `@router.websocket`, etc.) produce no routes.
 *
 * Returned routes use the same `ExtractedRoute` shape that the parse
 * worker expects — see `ExtractedRoute` in
 * `src/core/ingestion/workers/parse-worker.ts`.
 */

import type Parser from 'tree-sitter';
import type { ExtractedRoute } from '../workers/parse-worker.js';

const HTTP_VERB_MAP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
  head: 'HEAD',
  options: 'OPTIONS',
  // (#79) FastAPI exposes `trace` as a valid HTTP verb on the router; include it
  // for completeness even though it is rarely used in production APIs.
  trace: 'TRACE',
};

/** Verbs that the tree-sitter-python grammar emits for the call site. */
const SUPPORTED_VERB_LOWER = new Set(Object.keys(HTTP_VERB_MAP));

/**
 * Public entry point: walk a parsed Python tree and extract every FastAPI
 * HTTP route decorator. Returns an empty array if `tree` is null/empty.
 */
export function extractFastApiRoutes(tree: Parser.Tree, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  if (!tree || !tree.rootNode) return routes;
  walk(tree.rootNode, routes, filePath);
  return routes;
}

/**
 * Recursive AST walker. Identifies `decorator` nodes whose call expression
 * is `receiver.METHOD(...)` with a method we recognize as an HTTP verb
 * and a string-literal first argument.
 */
function walk(node: Parser.SyntaxNode, routes: ExtractedRoute[], filePath: string): void {
  if (!node) return;

  if (node.type === 'decorator') {
    const route = tryExtractRoute(node, filePath);
    if (route) routes.push(route);
  }

  for (const child of node.children ?? []) {
    walk(child, routes, filePath);
  }
}

/**
 * Inspect a single `decorator` node. Returns a route or null.
 *
 * Decorator shape in tree-sitter-python:
 *   decorator
 *     '@'
 *     call
 *       function: attribute
 *         object:  <identifier | attribute>     ← receiver (e.g. "app", "router")
 *         attribute: identifier                 ← method name (e.g. "get", "post")
 *       arguments: argument_list
 *         ( string | keyword_argument ... )
 *
 * The decorated function is the next sibling in the parent's `block` — we
 * read it from the parent so we can populate `methodName` accurately.
 */
function tryExtractRoute(decorator: Parser.SyntaxNode, filePath: string): ExtractedRoute | null {
  // The decorator's child after '@' is typically a `call` or a bare
  // identifier. FastAPI routes are always calls, so we only consider calls.
  const call = decorator.children.find((c) => c.type === 'call');
  if (!call) return null;

  // `call.function` is the attribute (e.g. `app.get`)
  const func = call.childForFieldName('function') ?? call.children[0];
  if (!func || func.type !== 'attribute') return null;

  // The attribute (right side) — in tree-sitter-python this is the
  // `attribute` field on the `attribute` node, and is always an
  // `identifier` node carrying the method name (e.g. "get", "post").
  const attrNode = func.childForFieldName('attribute');
  if (!attrNode || attrNode.type !== 'identifier') return null;
  const verbLower = attrNode.text.toLowerCase();
  if (!SUPPORTED_VERB_LOWER.has(verbLower)) return null;

  const httpMethod = HTTP_VERB_MAP[verbLower];

  // Receiver (object side of the attribute). Could be `app`, `router`,
  // `api_router`, or even a nested attribute — we only need the textual name.
  const objectNode = func.childForFieldName('object') ?? func.children[0];
  const receiverName = (objectNode?.text ?? '').trim() || null;

  // Pull the route path from the first positional string argument.
  const argsNode =
    call.childForFieldName('arguments') ?? call.children.find((c) => c.type === 'argument_list');
  if (!argsNode) return null;
  const routePath = extractFirstStringArg(argsNode);
  if (routePath === null) return null;

  // The decorated function: tree-sitter-python puts decorators on a
  // `decorated_definition` parent that wraps the actual
  // `function_definition` (or `async_function_definition`). Look one
  // level up from the decorator, and if it's a `decorated_definition`,
  // find the function node inside it.
  const parent = decorator.parent;
  const decorated = parent?.type === 'decorated_definition' ? parent : null;
  const funcNode = decorated
    ? decorated.children.find((c) => isFunctionLike(c))
    : parent && isFunctionLike(parent)
      ? parent
      : null;
  const methodName = funcNode ? getFunctionName(funcNode) : null;

  return {
    filePath,
    httpMethod,
    routePath,
    controllerName: receiverName,
    methodName,
    middleware: [],
    prefix: null,
    lineNumber: decorator.startPosition?.row ?? 0,
    isControllerClass: false,
    isInherited: false,
  };
}

/**
 * Iterate an `argument_list` and return the string value of the first
 * positional string node, or null if no string-literal positional arg
 * exists.
 *
 * tree-sitter-python's `argument_list` may contain either:
 *   - bare `string` / `string_literal` nodes (positional args), or
 *   - `argument` wrappers around an expression, or
 *   - `keyword_argument` nodes (which we skip — `response_model=...`,
 *     `status_code=...` etc. are not paths).
 *
 * We deliberately skip keyword arguments to avoid treating a
 * `response_model="User"` style kwarg as a path.
 */
function extractFirstStringArg(argsNode: Parser.SyntaxNode): string | null {
  for (const arg of argsNode.children) {
    if (arg.isMissing) continue;
    if (arg.type === 'keyword_argument') continue;
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;

    // Bare string node directly in the argument list (tree-sitter-python
    // does not always wrap a single string arg in an `argument` node).
    if (arg.type === 'string' || arg.type === 'string_literal') {
      return unquote(arg.text);
    }

    // Wrapped argument: dig into the child expression.
    const inner =
      arg.childForFieldName('value') ??
      arg.children.find(
        (c) => c.type === 'string' || c.type === 'string_literal',
      );
    if (inner) return unquote(inner.text);
  }
  return null;
}

/** Strip surrounding single, double, or triple quotes from a Python string. */
function unquote(raw: string): string {
  // Triple-quoted: """...""" or '''...'''
  if (/^""".*"""$|^'''.*'''$/s.test(raw)) {
    return raw.slice(3, -3);
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw) || /^'(?:[^'\\]|\\.)*'$/.test(raw)) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Return true if the node is one of the function-like definitions in Python. */
function isFunctionLike(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'function_definition' ||
    node.type === 'async_function_definition' ||
    // Some grammars (older or alternative) collapse both into a single
    // node type with an `async` flag — be defensive.
    node.type === 'function_def'
  );
}

/** Best-effort extraction of the function name from a function-like node. */
function getFunctionName(funcNode: Parser.SyntaxNode): string | null {
  const nameNode = funcNode.childForFieldName('name') ??
    funcNode.namedChildren.find((c) => c.type === 'identifier');
  return nameNode?.text ?? null;
}
