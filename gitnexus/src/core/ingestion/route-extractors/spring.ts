/**
 * Spring route annotation extractor for the ingestion pipeline.
 *
 * Extracts `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`,
 * `@PatchMapping`, and `@RequestMapping` annotations from Java source files
 * and returns `ExtractedDecoratorRoute[]` with class-level `@RequestMapping`
 * prefixes already resolved per-class.
 *
 * This module is the ingestion-layer counterpart of
 * `group/extractors/http-patterns/java.ts` (which extracts HTTP contracts
 * for cross-repo matching). It uses the same tree-sitter capture approach:
 * a single predicate-free query matches all route annotations generically,
 * then a for-loop discriminates class-level prefixes from method-level routes
 * by reading `@node.type` and the annotation name.
 *
 * The query is predicate-free to avoid the tree-sitter 0.21.x hazard where
 * `#match?` / `#eq?` predicates in a top-level `[...]` alternation silently
 * drop sibling-branch matches (see group-layer `JAVA_ROUTE_ANNOTATION_PATTERNS`
 * header comment for details).
 */

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';

/** HTTP method mapping for Spring shortcut annotations. */
const METHOD_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/**
 * Single predicate-free tree-sitter query that captures all route annotations
 * on classes and methods. Discrimination by annotation name and node type
 * happens in the loop below.
 *
 * Captures:
 *   @ann   → annotation name identifier (RequestMapping, GetMapping, etc.)
 *   @node  → enclosing declaration (class_declaration | method_declaration)
 *   @value → the string-literal argument
 *   @key   → the named-argument member key (absent for positional form)
 */
const ROUTE_ANNOTATION_QUERY = new Parser.Query(
  Java,
  `
  [
    (class_declaration
      (modifiers
        (annotation
          name: (identifier) @ann
          arguments: (annotation_argument_list (string_literal) @value)))) @node
    (class_declaration
      (modifiers
        (annotation
          name: (identifier) @ann
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key
              value: (string_literal) @value))))) @node
    (method_declaration
      (modifiers
        (annotation
          name: (identifier) @ann
          arguments: (annotation_argument_list (string_literal) @value)))) @node
    (method_declaration
      (modifiers
        (annotation
          name: (identifier) @ann
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key
              value: (string_literal) @value))))) @node
  ]
`,
);

/** Strip surrounding quotes from a tree-sitter string_literal node text. */
function unquote(text: string): string {
  // string_literal includes the quotes: "foo" → extract inner string_fragment
  // But in matches, @value captures the full string_literal node; extract text
  // by stripping first/last character (the quote marks).
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Only `path` or `value` keys carry a route — skip `produces`, `consumes`, etc. */
function isRouteKey(keyNode: Parser.SyntaxNode | undefined): boolean {
  if (!keyNode) return true; // positional = always a route
  return keyNode.text === 'path' || keyNode.text === 'value';
}

/** Walk up from a method node to its enclosing class_declaration. */
function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract Spring route annotations from a parsed Java file.
 *
 * Uses a single tree-sitter query pass to capture all annotations, then
 * discriminates class-level prefixes from method-level routes in a loop.
 * Handles multiple classes per file, each with its own prefix.
 *
 * @param tree - tree-sitter parse tree
 * @param filePath - relative file path (for `ExtractedDecoratorRoute.filePath`)
 * @param lineOffset - line offset for pre-processing (usually 0)
 * @returns Decorator routes with prefix already set per-class
 */
export function extractSpringRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  const matches = ROUTE_ANNOTATION_QUERY.matches(tree.rootNode);

  // Phase 1: collect class-level @RequestMapping prefixes keyed by node id
  const prefixByClassId = new Map<number, string>();

  for (const match of matches) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const { name, node } of match.captures) {
      caps[name] = node;
    }
    const annNode = caps['ann'];
    const node = caps['node'];
    const valueNode = caps['value'];
    const keyNode = caps['key'];
    if (!annNode || !node || !valueNode) continue;

    if (node.type === 'class_declaration' && annNode.text === 'RequestMapping') {
      if (!isRouteKey(keyNode)) continue;
      prefixByClassId.set(node.id, unquote(valueNode.text));
    }
  }

  // Phase 2: collect method-level routes and resolve their class prefix
  const routes: ExtractedDecoratorRoute[] = [];

  for (const match of matches) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const { name, node } of match.captures) {
      caps[name] = node;
    }
    const annNode = caps['ann'];
    const node = caps['node'];
    const valueNode = caps['value'];
    const keyNode = caps['key'];
    if (!annNode || !node || !valueNode) continue;

    if (node.type !== 'method_declaration') continue;

    const ann = annNode.text;
    const httpMethod = METHOD_ANNOTATION_TO_HTTP[ann];
    if (!httpMethod) continue; // skip @RequestMapping on methods (ambiguous verb)
    if (!isRouteKey(keyNode)) continue;

    const routePath = unquote(valueNode.text);
    const enclosingClass = findEnclosingClass(node);
    const classPrefix = enclosingClass ? (prefixByClassId.get(enclosingClass.id) ?? '') : '';

    routes.push({
      filePath,
      routePath,
      httpMethod,
      decoratorName: ann,
      lineNumber: annNode.startPosition.row + lineOffset,
      ...(classPrefix ? { prefix: classPrefix } : {}),
    });
  }

  return routes;
}
