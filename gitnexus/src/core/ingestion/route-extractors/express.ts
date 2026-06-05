// Express/Hono route extraction
// Extracted from parse-worker.ts (#70). Pure AST-walk implementation; the
// tree-sitter Tree is passed in and its `Parser.SyntaxNode`s are walked.

import type Parser from 'tree-sitter';

/** Decorator-based route (Express/Hono/NestJS route handlers) */
export interface ExtractedDecoratorRoute {
  filePath: string;
  decorator: string;
  method?: string;
  path?: string;
  lineNumber?: number;
}

/**
 * Extract Express/Hono route registrations from JavaScript/TypeScript files via AST walk.
 * Handles: app.get('/path', handler), app.post('/path', handler), router.get('/path', handler), etc.
 */
export function extractExpressRoutes(tree: Parser.Tree, filePath: string): ExtractedDecoratorRoute[] {
  const routes: ExtractedDecoratorRoute[] = [];
  const EXPRESS_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'route', 'head', 'options']);

  // Non-Express objects that have .get()/.post() etc. methods - these are NOT route registrations
  const NON_EXPRESS_OBJECTS = new Set([
    'headers', 'request', 'response', 'req', 'res',  // HTTP request/response
    'map', 'set', 'weakmap', 'weakset',  // Collections
    'cache', 'storage',  // Storage APIs
    'formdata', 'urlsearchparams',  // Form APIs
    'promise', 'observable',  // Async APIs
  ]);

  function walk(node: Parser.SyntaxNode): void {
    if (!node) {
      return;
    }

    // Check if this is a call_expression with a member_expression function (e.g., app.get)
    if (node.type === 'call_expression') {
      const func = node.childForFieldName('function') ?? node.children[0];
      if (func?.type === 'member_expression') {
        const prop = func.childForFieldName('property') ?? func.children[func.childCount - 1];
        if (prop?.type === 'property_identifier' && EXPRESS_METHODS.has(prop.text)) {
          // Check if this is likely NOT an Express route (e.g., request.headers.get())
          // Get the object of the member expression
          const obj = func.childForFieldName('object') ?? func.children[0];
          if (obj) {
            // For chained calls like app.route('/path').get(), obj is a call_expression
            // For direct calls like app.get('/path'), obj is an identifier
            // For non-Express like request.headers.get(), obj is a member_expression

            // Skip if object is a known non-Express pattern
            if (obj.type === 'member_expression') {
              const objProp = obj.childForFieldName('property') ?? obj.children[obj.childCount - 1];
              if (objProp?.type === 'property_identifier' && NON_EXPRESS_OBJECTS.has(objProp.text.toLowerCase())) {
                // This is NOT an Express route - skip it and recurse into children
                for (const child of node.children) {
                  walk(child);
                }
                return;
              }
            } else if (obj.type === 'identifier' && NON_EXPRESS_OBJECTS.has(obj.text.toLowerCase())) {
              // Direct call like headers.get() - skip
              for (const child of node.children) {
                walk(child);
              }
              return;
            }
          }

          // Found an Express route registration
          const args = node.childForFieldName('arguments') ?? node.children.find((c: Parser.SyntaxNode) => c.type === 'arguments');
          if (args) {
            for (const arg of args.children) {
              if (arg.type === 'string') {
                const routePath = arg.text.replace(/^["']|["']$/g, '');
                routes.push({
                  filePath,
                  decorator: prop.text,
                  path: routePath,
                  lineNumber: node.startPosition.row,
                });
                break;
              }
            }
          }
        }
      }
    }

    // Recurse into children
    for (const child of node.children) {
      walk(child);
    }
  }

  if (!tree || !tree.rootNode) return routes;
  walk(tree.rootNode);
  return routes;
}
