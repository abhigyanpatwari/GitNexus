// Extracts Gin (and Gin-style) HTTP routes from Go source code.
//
// Gin registers routes via method calls on a router/engine receiver:
//   r := gin.Default()
//   r.GET("/users", listUsers)
//   r.POST("/users", createUser)
//   router.DELETE("/users/:id", deleteUser)
//
// We walk the tree-sitter Go AST looking for call_expression nodes whose
// function is a selector_expression with a Gin HTTP-method field name.
// The first string argument becomes the route path; the second argument
// (when it is an identifier) is recorded as the handler.
//
// This is a deliberately minimal extractor: receiver name, method, path,
// handler identifier, line. Group prefixes (r.Group(...)) and middleware
// chains are not yet modeled — kept in scope for a follow-up.

import type Parser from 'tree-sitter';
import type { ExtractedRoute } from '../workers/parse-worker.js';

/** Gin HTTP-method receiver fields. */
const GIN_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'Any',
  'Redirect',
  'Static',
  'StaticFS',
]);

interface SelectorParts {
  receiver: string;
  field: string;
}

/** Get the text of a call_expression's function child (selector or identifier). */
function getFunctionText(call: Parser.SyntaxNode): string | null {
  if (!call) return null;
  // tree-sitter-go: call_expression → function: selector_expression | identifier
  const fn = call.childForFieldName('function')
    ?? call.namedChildren.find((c) => c.type === 'selector_expression' || c.type === 'identifier');
  return fn ? fn.text : null;
}

/** Parse "r.GET" into { receiver: "r", field: "GET" }. */
function parseSelector(selectorText: string): SelectorParts | null {
  const dot = selectorText.lastIndexOf('.');
  if (dot <= 0 || dot >= selectorText.length - 1) return null;
  return {
    receiver: selectorText.slice(0, dot),
    field: selectorText.slice(dot + 1),
  };
}

/** Extract a string literal value from a Go interpreted/raw string literal node. */
function extractStringLiteral(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  // tree-sitter-go string types: interpreted_string_literal, raw_string_literal
  if (node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal') {
    const raw = node.text ?? '';
    if (raw.length >= 2) {
      const first = raw[0];
      const last = raw[raw.length - 1];
      if ((first === '"' || first === '`') && first === last) {
        return raw.slice(1, -1);
      }
    }
    return raw;
  }
  // Fallback for other grammars
  if (node.type === 'string_literal') {
    return (node.text ?? '').replace(/^["'`]/, '').replace(/["'`]$/, '');
  }
  return null;
}

/** Get the first positional argument node from a Go call_expression's argument_list. */
function getArgByIndex(call: Parser.SyntaxNode, index: number): Parser.SyntaxNode | null {
  if (!call) return null;
  let argList: Parser.SyntaxNode | null = null;
  for (const child of call.children) {
    if (child.type === 'argument_list') {
      argList = child;
      break;
    }
  }
  if (!argList) return null;
  return argList.namedChildren[index] ?? null;
}

/** Get the line (0-based) of a node, falling back to 0. */
function lineOf(node: Parser.SyntaxNode | null): number {
  return node?.startPosition.row ?? 0;
}

/**
 * Walk an AST and collect every `<receiver>.METHOD(...)` call where METHOD
 * is a known Gin HTTP-method name AND the first argument is a string literal.
 *
 * @param tree - tree-sitter tree whose root is a Go source file
 * @param filePath - path of the file (passed through to ExtractedRoute.filePath)
 */
export function extractGinRoutes(tree: Parser.Tree, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  if (!tree || !tree.rootNode) return routes;

  walk(tree.rootNode);

  return routes;

  function walk(node: Parser.SyntaxNode): void {
    if (!node) return;

    if (node.type === 'call_expression') {
      const fnText = getFunctionText(node);
      if (fnText) {
        const selector = parseSelector(fnText);
        if (selector && GIN_METHODS.has(selector.field)) {
          const firstArg = getArgByIndex(node, 0);
          if (firstArg) {
            const path = extractStringLiteral(firstArg);
            if (path !== null) {
              const secondArg = getArgByIndex(node, 1);
              const handler = secondArg?.type === 'identifier' ? secondArg.text : null;

              routes.push({
                filePath,
                httpMethod: selector.field,
                routePath: path,
                controllerName: selector.receiver,
                methodName: handler,
                middleware: [],
                prefix: null,
                lineNumber: lineOf(node),
                isControllerClass: false,
              });
            }
          }
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }
}
