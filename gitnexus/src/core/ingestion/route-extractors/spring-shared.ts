/**
 * Shared Spring route-annotation primitives.
 *
 * These are the low-level building blocks the two Spring route extractors —
 * the ingestion-layer `route-extractors/spring.ts` (produces graph `Route`
 * nodes) and the group-layer `group/extractors/http-patterns/java.ts`
 * (produces cross-repo HTTP contracts) — would otherwise each maintain
 * independently. Centralising the annotation→method map, the enclosing-class
 * lookup, and the route-key filter keeps those semantics in one place so the
 * two extractors can't drift apart.
 *
 * This module lives in `ingestion/` (the lower layer); the group layer imports
 * from it, matching the existing `group → ingestion` dependency direction
 * (e.g. `group/extractors/include-extractor.ts` already imports
 * `ingestion/import-resolvers/utils.ts`). It MUST NOT import anything from
 * `group/` to avoid a dependency cycle.
 */

import type Parser from 'tree-sitter';

/**
 * Spring shortcut method-annotation → HTTP verb.
 *
 * `@RequestMapping` is intentionally absent: on a method it carries no implicit
 * verb (the verb lives in its `method = RequestMethod.X` attribute), and on a
 * class it is a URL prefix rather than a route. Callers handle `@RequestMapping`
 * separately.
 */
export const METHOD_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/**
 * A named annotation argument contributes a route only when its member key is
 * `path` or `value`; a positional argument (no key node) always qualifies.
 * Drops Spring's non-route string attributes (`produces`, `consumes`,
 * `headers`, `name`, `params`) that would otherwise be mis-read as routes.
 */
export function isRouteMemberKey(keyNode: Parser.SyntaxNode | undefined): boolean {
  if (!keyNode) return true;
  return keyNode.text === 'path' || keyNode.text === 'value';
}

/**
 * Find the nearest enclosing `class_declaration` ancestor for a node, or null
 * if the node is top-level. Tree-sitter's `SyntaxNode.parent` walks one level
 * at a time.
 */
export function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Strip enclosing quotes from a tree-sitter string-literal node's text.
 * Handles single / double / template (backtick) quotes and triple-quoted
 * strings. Mirrors the safer semantics of the group layer's `unquoteLiteral`:
 * returns `null` for empty / nullish input so callers can uniformly skip
 * captures whose value is missing, and returns the text unchanged when it
 * carries no recognisable surrounding quotes (some grammars expose string
 * content without quotes already).
 */
export function unquoteSpringLiteral(raw: string): string | null {
  if (!raw) return null;

  if (
    (raw.startsWith('"""') && raw.endsWith('"""')) ||
    (raw.startsWith("'''") && raw.endsWith("'''"))
  ) {
    return raw.slice(3, -3);
  }

  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' || first === "'" || first === '`') && last === first && raw.length >= 2) {
    return raw.slice(1, -1);
  }

  return raw;
}
