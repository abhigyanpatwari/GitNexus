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
 * for cross-repo matching). The group layer uses its own tree-sitter queries;
 * this module reuses the parse-worker's `@decorator` capture mechanism but
 * owns the prefix-joining logic so `parse-worker.ts` stays language-agnostic.
 */

import type Parser from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';

/** HTTP method mapping for Spring shortcut annotations. */
const METHOD_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/** All annotation names that define route endpoints (class or method level). */
const SPRING_ROUTE_ANNOTATIONS = new Set([
  'RequestMapping',
  ...Object.keys(METHOD_ANNOTATION_TO_HTTP),
]);

/**
 * Extract a string-literal annotation argument (positional or named `path`/`value`).
 * Returns null if the annotation has no recognisable string argument.
 */
function extractAnnotationPath(annotationNode: Parser.SyntaxNode): string | null {
  const argList = annotationNode.childForFieldName('arguments');
  if (!argList) return null;

  for (const child of argList.namedChildren) {
    // Positional: (string_literal (string_fragment))
    if (child.type === 'string_literal') {
      const frag = child.namedChildren.find((c) => c.type === 'string_fragment');
      return frag?.text ?? null;
    }
    // Named: (element_value_pair key: (identifier) value: (string_literal ...))
    if (child.type === 'element_value_pair') {
      const key = child.childForFieldName('key');
      if (key && (key.text === 'path' || key.text === 'value')) {
        const value = child.childForFieldName('value');
        if (value?.type === 'string_literal') {
          const frag = value.namedChildren.find((c) => c.type === 'string_fragment');
          return frag?.text ?? null;
        }
      }
    }
  }
  return null;
}

/**
 * Find route-defining annotations on a declaration's modifiers node.
 * Returns annotation name + extracted path for each match.
 */
function findRouteAnnotations(
  modifiersNode: Parser.SyntaxNode | null,
): Array<{ name: string; path: string; annotationNode: Parser.SyntaxNode }> {
  if (!modifiersNode) return [];
  const results: Array<{ name: string; path: string; annotationNode: Parser.SyntaxNode }> = [];

  for (const child of modifiersNode.namedChildren) {
    if (child.type !== 'annotation') continue;
    const nameNode = child.childForFieldName('name');
    if (!nameNode) continue;
    const name = nameNode.text;
    if (!SPRING_ROUTE_ANNOTATIONS.has(name)) continue;
    const path = extractAnnotationPath(child) ?? '';
    results.push({ name, path, annotationNode: child });
  }
  return results;
}

/**
 * Extract Spring route annotations from a parsed Java file.
 *
 * Walks the AST for class declarations with `@RequestMapping` prefixes and
 * method declarations with route annotations. Handles multiple classes per
 * file, each with its own prefix.
 *
 * @param tree - tree-sitter parse tree
 * @param filePath - relative file path (for `ExtractedDecoratorRoute.filePath`)
 * @param lineOffset - line offset for Vue SFC / similar pre-processing (usually 0)
 * @returns Decorator routes with prefix already set per-class
 */
export function extractSpringRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  const routes: ExtractedDecoratorRoute[] = [];

  // Walk all class declarations in the file
  const classNodes = collectNodes(tree.rootNode, 'class_declaration');

  for (const classNode of classNodes) {
    const modifiers = classNode.namedChildren.find((c) => c.type === 'modifiers') ?? null;
    const classAnnotations = findRouteAnnotations(modifiers);

    // Find class-level @RequestMapping prefix
    const classPrefixAnnotation = classAnnotations.find((a) => a.name === 'RequestMapping');
    const classPrefix = classPrefixAnnotation?.path ?? '';

    // Walk method declarations inside this class
    const methodNodes = collectDirectMethods(classNode);

    for (const methodNode of methodNodes) {
      const methodModifiers = methodNode.namedChildren.find((c) => c.type === 'modifiers') ?? null;
      const methodAnnotations = findRouteAnnotations(methodModifiers);

      for (const ann of methodAnnotations) {
        // Skip class-level-only annotations on methods (e.g. bare @RequestMapping
        // on a method — treated as GET with the given path)
        const httpMethod = METHOD_ANNOTATION_TO_HTTP[ann.name] ?? 'GET';

        routes.push({
          filePath,
          routePath: ann.path,
          httpMethod,
          decoratorName: ann.name,
          lineNumber: ann.annotationNode.startPosition.row + lineOffset,
          ...(classPrefix ? { prefix: classPrefix } : {}),
        });
      }
    }
  }

  return routes;
}

/** Recursively collect nodes of a given type (skipping nested classes). */
function collectNodes(root: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === type) {
      results.push(node);
      return; // don't recurse into nested classes
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(root);
  return results;
}

/** Collect direct method declarations inside a class (not from nested classes). */
function collectDirectMethods(classNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const methods: Parser.SyntaxNode[] = [];
  const body = classNode.childForFieldName('body');
  if (!body) return methods;

  const visit = (node: Parser.SyntaxNode): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'method_declaration') {
        methods.push(child);
      } else if (child.type !== 'class_declaration' && child.type !== 'interface_declaration') {
        visit(child);
      }
    }
  };
  visit(body);
  return methods;
}
