import PHP from 'tree-sitter-php';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type CompiledPatterns,
  type LanguagePatterns,
  type PatternSpec,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * PHP HTTP plugin.
 *
 * Providers:
 *   - Laravel `Route::get/post/...`
 *
 * Consumers (string-literal URLs only):
 *   - Laravel HTTP client: `Http::get/post/put/delete/patch($url)`
 *   - Guzzle / generic object method: `$client->get/post/...($url)`
 *   - `file_get_contents($url)`
 *
 * The pipeline already uses `PHP.php_only` for ingesting plain `.php`
 * files (see `core/tree-sitter/parser-loader.ts`), and we do the same
 * here so Laravel route files are parsed with the right grammar dialect.
 *
 * Scope notes: consumer patterns match string literals only. URLs built
 * via binary concatenation (`$base . '/path'`), `sprintf`, or config
 * lookup (`config('services.foo.base').'/path'`) are intentionally left
 * for a follow-up — they require constant-folding the surrounding
 * scope to be meaningful.
 */

const LARAVEL_ROUTE_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (scoped_call_expression
      scope: (name) @scope (#eq? @scope "Route")
      name: (name) @method (#match? @method "^(get|post|put|delete|patch)$")
      arguments: (arguments . (argument (string) @path)))
  `,
};

const HTTP_FACADE_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (scoped_call_expression
      scope: (name) @scope (#eq? @scope "Http")
      name: (name) @method (#match? @method "^(get|post|put|delete|patch)$")
      arguments: (arguments . (argument (string) @path)))
  `,
};

const GUZZLE_MEMBER_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (member_call_expression
      name: (name) @method (#match? @method "^(get|post|put|delete|patch)$")
      arguments: (arguments . (argument (string) @path)))
  `,
};

const FILE_GET_CONTENTS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (function_call_expression
      function: (name) @fn (#eq? @fn "file_get_contents")
      arguments: (arguments . (argument (string) @path)))
  `,
};

interface PhpPatternBundle {
  laravelRoute: CompiledPatterns<Record<string, never>>;
  httpFacade: CompiledPatterns<Record<string, never>>;
  guzzleMember: CompiledPatterns<Record<string, never>>;
  fileGetContents: CompiledPatterns<Record<string, never>>;
}

const mk = (spec: PatternSpec<Record<string, never>>, suffix: string) =>
  compilePatterns({
    name: `php-${suffix}`,
    language: PHP.php_only,
    patterns: [spec],
  } satisfies LanguagePatterns<Record<string, never>>);

const PHP_PATTERNS: PhpPatternBundle = {
  laravelRoute: mk(LARAVEL_ROUTE_SPEC, 'laravel-route'),
  httpFacade: mk(HTTP_FACADE_SPEC, 'http-facade'),
  guzzleMember: mk(GUZZLE_MEMBER_SPEC, 'guzzle-member'),
  fileGetContents: mk(FILE_GET_CONTENTS_SPEC, 'file-get-contents'),
};

/**
 * Extract the inner text of a PHP `string` node. The tree-sitter-php
 * grammar wraps single / double-quoted literals differently depending
 * on content; we try both the raw `text` (with quotes) through
 * `unquoteLiteral`, and a fallback via the `string_value` / `string_content`
 * child nodes.
 */
function phpStringText(node: import('tree-sitter').SyntaxNode): string | null {
  const direct = unquoteLiteral(node.text);
  if (direct !== null && direct !== node.text) return direct;
  for (const child of node.children) {
    if (child.type === 'string_content' || child.type === 'string_value') {
      return child.text;
    }
  }
  return direct;
}

/**
 * HTTP client helpers (`Http::`, Guzzle) are almost always called with
 * a path relative to a configured base URL, or a full URL. File paths
 * are rare. Accept both relative (`/api/...`) and absolute (`http(s)://`).
 */
function isHttpClientPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('http://') || path.startsWith('https://');
}

/**
 * `file_get_contents` is used for both HTTP and filesystem reads. Only
 * emit a consumer contract when the URL is an absolute HTTP(S) URL to
 * avoid false positives for local file paths and stream wrappers
 * (`php://input`, `file://`, `data:`, ...).
 */
function isHttpUrlLiteral(path: string): boolean {
  return path.startsWith('http://') || path.startsWith('https://');
}

export const PHP_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'php-http',
  language: PHP.php_only,
  scan(tree) {
    const out: HttpDetection[] = [];

    for (const match of runCompiledPatterns(PHP_PATTERNS.laravelRoute, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = phpStringText(pathNode);
      if (path === null) continue;
      out.push({
        role: 'provider',
        framework: 'laravel',
        method: methodNode.text.toUpperCase(),
        path,
        name: 'route',
        confidence: 0.8,
      });
    }

    for (const match of runCompiledPatterns(PHP_PATTERNS.httpFacade, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = phpStringText(pathNode);
      if (path === null || !isHttpClientPath(path)) continue;
      out.push({
        role: 'consumer',
        framework: 'laravel-http',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        confidence: 0.7,
      });
    }

    for (const match of runCompiledPatterns(PHP_PATTERNS.guzzleMember, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = phpStringText(pathNode);
      if (path === null || !isHttpClientPath(path)) continue;
      out.push({
        role: 'consumer',
        framework: 'guzzle',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        confidence: 0.7,
      });
    }

    for (const match of runCompiledPatterns(PHP_PATTERNS.fileGetContents, tree)) {
      const pathNode = match.captures.path;
      if (!pathNode) continue;
      const path = phpStringText(pathNode);
      if (path === null || !isHttpUrlLiteral(path)) continue;
      out.push({
        role: 'consumer',
        framework: 'file-get-contents',
        method: 'GET',
        path,
        name: null,
        confidence: 0.7,
      });
    }

    return out;
  },
};
