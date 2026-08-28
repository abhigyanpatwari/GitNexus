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
 * Consumers (string-literal URLs only, unless noted):
 *   - Laravel HTTP client: `Http::get/post/put/delete/patch($url)`
 *   - Guzzle / generic object method: `$client->get/post/...($url)`
 *   - `file_get_contents($url)`
 *   - `new Request($method, $host . $resourcePath)` — the openapi-generator-php
 *     / swagger-codegen client shape. `$resourcePath` is resolved via a
 *     single-scope backward constant fold (see `resolveLocalStringLiteral`),
 *     not a string literal at the call site itself.
 *
 * The pipeline already uses `PHP.php_only` for ingesting plain `.php`
 * files (see `core/tree-sitter/parser-loader.ts`), and we do the same
 * here so Laravel route files are parsed with the right grammar dialect.
 *
 * Scope notes: consumer patterns match string literals only, with one
 * narrow exception (above). URLs built via `sprintf`, config lookup
 * (`config('services.foo.base').'/path'`), or a variable resolved from
 * outside its own function/method body are intentionally left for a
 * follow-up — they require constant-folding beyond one local scope to
 * be meaningful.
 *
 * That narrow exception (`resolveLocalStringLiteral`) is a temporary,
 * single-scope fallback, not this language's entry into the shared
 * cross-file constant-fold used by the other languages in this plugin
 * (`constant-resolver.ts`, wired in via `java-const-resolver.ts` /
 * `python-const-resolver.ts` / `js-const-resolver.ts`). PHP has no such
 * binding yet — adding one is a real, separate project (this repo's PHP
 * import resolution for `use`-statements is its own multi-file subsystem
 * under `ingestion/import-resolvers/php.ts`, built for symbol/scope
 * resolution, not constant extraction) and is intentionally out of scope
 * here. Tracked as a follow-up, not silently punted.
 */

const LARAVEL_ROUTE_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (scoped_call_expression
      scope: (name) @scope (#eq? @scope "Route")
      name: (name) @method (#match? @method "^(get|post|put|delete|patch)$")
      arguments: (arguments
        . (argument (string) @path)
        (argument [(anonymous_function) (arrow_function)] @closure)?))
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

/**
 * `new Request($method, $host . $resourcePath)` — the shape swagger-codegen /
 * openapi-generator-php emit for every operation of a generated API client
 * (Guzzle's `\GuzzleHttp\Psr7\Request`, or a bare `Request` behind a `use`
 * import). Matches both `(name)` and `(qualified_name)` class references;
 * `scan()` below filters to the last path segment being exactly `Request`
 * and resolves the concatenated path argument (see `resolveLocalStringLiteral`).
 */
const GUZZLE_REQUEST_CTOR_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (object_creation_expression
      [(name) (qualified_name)] @class
      (arguments
        . (argument (_) @methodArg)
        . (argument (_) @pathArg)))
  `,
};

interface PhpPatternBundle {
  laravelRoute: CompiledPatterns<Record<string, never>>;
  httpFacade: CompiledPatterns<Record<string, never>>;
  guzzleMember: CompiledPatterns<Record<string, never>>;
  fileGetContents: CompiledPatterns<Record<string, never>>;
  guzzleRequestCtor: CompiledPatterns<Record<string, never>>;
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
  guzzleRequestCtor: mk(GUZZLE_REQUEST_CTOR_SPEC, 'guzzle-request-ctor'),
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

/**
 * Last identifier segment of a class-name reference: `(name)` returns its
 * own text, `(qualified_name)` returns the text of its last child (the
 * unqualified class name — `\GuzzleHttp\Psr7\Request` → `Request`).
 */
function lastNameSegment(node: import('tree-sitter').SyntaxNode): string {
  if (node.type === 'qualified_name') {
    const last = node.child(node.childCount - 1);
    return last ? last.text : node.text;
  }
  return node.text;
}

/**
 * Walk a (possibly nested, left-associative) `.`-concatenation expression
 * and return the LAST `variable_name` leaf in source order — generated
 * clients build `<host> . <resourcePath>`, so the path segment is the one
 * closest to the end. Non-variable operands (property access, literals,
 * ternaries, function calls, ...) are skipped without contributing a
 * candidate; this is a single lookup, not a fallback list — only one
 * variable is ever resolved per call.
 *
 * `parenthesized_expression` is unwrapped, not skipped: an unhandled
 * paren on the right operand must NOT fall through to the left operand —
 * that would silently return an earlier (wrong) variable — e.g.
 * `$host . ($resourcePath . $suffix)` would resolve to `$host` instead of
 * failing to find anything inside the parens.
 */
function lastConcatVariable(
  node: import('tree-sitter').SyntaxNode,
): import('tree-sitter').SyntaxNode | null {
  if (node.type === 'variable_name') return node;
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChild(0);
    return inner ? lastConcatVariable(inner) : null;
  }
  if (node.type === 'binary_expression') {
    const right = node.childForFieldName('right');
    const fromRight = right ? lastConcatVariable(right) : null;
    if (fromRight) return fromRight;
    const left = node.childForFieldName('left');
    return left ? lastConcatVariable(left) : null;
  }
  return null;
}

/**
 * Best-effort, single-scope constant fold: given a `variable_name` node
 * referenced inside a `new Request(...)` argument, walk BACKWARD through
 * the preceding statements of its immediately enclosing function/method
 * body (or file scope, for top-level script code) looking for the nearest
 * `$var = '<literal>';` assignment.
 *
 * "Enclosing body" is resolved level by level, not just the nearest
 * `compound_statement` — a call site nested in `if`/`foreach`/`try` inside
 * that function is still within the same function/method body, and a
 * preceding assignment above that conditional must still be found. Each
 * level searches only its own preceding siblings, then the search
 * continues from the enclosing block itself (not descending into other
 * branches) one level up; it stops at `program`, so it never crosses into
 * a different function or the containing class body.
 *
 * Deliberately conservative and bounded — no interprocedural resolution,
 * no constant/property lookups, no reassignment tracking across
 * conditionals or loops. A miss just means the endpoint stays
 * undetected, never a wrong one: this is exactly the class of case the
 * module docblock flags as in-scope only for one local scope.
 */
function resolveLocalStringLiteral(varNode: import('tree-sitter').SyntaxNode): string | null {
  const target = varNode.text; // includes the `$` sigil, e.g. "$resourcePath"
  let cursor: import('tree-sitter').SyntaxNode = varNode;

  for (;;) {
    let scope: import('tree-sitter').SyntaxNode | null = cursor.parent;
    while (scope && scope.type !== 'compound_statement' && scope.type !== 'program') {
      scope = scope.parent;
    }
    if (!scope) return null;

    let stmt: import('tree-sitter').SyntaxNode | null = cursor;
    while (stmt && stmt.parent !== scope) stmt = stmt.parent;
    if (!stmt) return null;

    let sibling = stmt.previousNamedSibling;
    while (sibling) {
      if (sibling.type === 'expression_statement') {
        const inner = sibling.namedChild(0);
        if (inner && inner.type === 'assignment_expression') {
          const lhs = inner.childForFieldName('left');
          const rhs = inner.childForFieldName('right');
          if (
            lhs &&
            lhs.type === 'variable_name' &&
            lhs.text === target &&
            rhs &&
            rhs.type === 'string'
          ) {
            return phpStringText(rhs);
          }
        }
      }
      sibling = sibling.previousNamedSibling;
    }

    if (scope.type === 'program') return null;
    cursor = scope; // one block up: search resumes from this block's own position
  }
}

export const PHP_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'php-http',
  language: PHP.php_only,
  // Laravel `Route::<verb>(...)` definitions are emitted as Route nodes by
  // ingestion, so the graph is authoritative for PHP providers (#2138 Part 2).
  routeCoverage: 'complete',
  // Consumer signals scan() can detect: Laravel `Http::<verb>`, Guzzle client
  // `->get/post/.../request(...)`, `file_get_contents` of an HTTP URL, and a
  // generated-client `new ...Request(...)` constructor call. A provider-covered
  // file with any of these must still be parsed (ingestion emits no FETCHES for
  // PHP). Conservative — the `->verb(`/`new ...Request(` shapes over-match
  // ordinary method calls and unrelated constructors, which only costs a
  // parse, never data.
  hasConsumerSignals(content) {
    return /Http::|file_get_contents|->\s*(get|post|put|delete|patch|request)\s*\(|new\s+[\\\w]*Request\s*\(/i.test(
      content,
    );
  },
  scan(tree) {
    const out: HttpDetection[] = [];

    for (const match of runCompiledPatterns(PHP_PATTERNS.laravelRoute, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = phpStringText(pathNode);
      if (path === null) continue;
      // A closure handler (`Route::get('/x', function(){…})` / `fn() => …`) has
      // no name → emit `name: null` + the registration line so it resolves to
      // its containing symbol (e.g. a service-provider `boot()` or controller
      // method) by line-span containment. A named-controller route keeps the
      // `'route'` label — resolving its array/string handler to a real method is
      // a separate, graph-backed concern. NOTE: a closure at FILE scope
      // (routes/web.php) has no enclosing function and PHP closures are not yet
      // indexed as symbols, so it still degrades to file-level (see #2276).
      const closureNode = match.captures.closure;
      out.push({
        role: 'provider',
        framework: 'laravel',
        method: methodNode.text.toUpperCase(),
        path,
        name: closureNode ? null : 'route',
        line: (closureNode ?? pathNode).startPosition.row + 1,
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
        line: pathNode.startPosition.row + 1,
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
        line: pathNode.startPosition.row + 1,
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
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    for (const match of runCompiledPatterns(PHP_PATTERNS.guzzleRequestCtor, tree)) {
      const classNode = match.captures.class;
      const methodArg = match.captures.methodArg;
      const pathArg = match.captures.pathArg;
      if (!classNode || !methodArg || !pathArg) continue;
      if (lastNameSegment(classNode) !== 'Request') continue;

      // Path: a direct string literal, or the last variable in a
      // concatenation chain (see `lastConcatVariable`) resolved to a
      // locally-assigned literal.
      let path: string | null = null;
      if (pathArg.type === 'string') {
        path = phpStringText(pathArg);
      } else {
        const lastVar = lastConcatVariable(pathArg);
        path = lastVar ? resolveLocalStringLiteral(lastVar) : null;
      }
      if (path === null || !isHttpClientPath(path)) continue;

      // The HTTP verb is frequently itself a parameter in generated clients
      // (`function pay($body) { ...; new Request($method, ...); }` where
      // `$method` is fixed by the caller, not this call site) — resolving it
      // would need the same interprocedural reach the module docblock rules
      // out. A literal verb is used when present; otherwise the method is
      // reported as a wildcard, matching this project's own convention for
      // a contract whose verb isn't pinned (see manifest links, `http::*::`).
      const method = methodArg.type === 'string' ? phpStringText(methodArg) : null;

      out.push({
        role: 'consumer',
        framework: 'guzzle-request-ctor',
        method: method ? method.toUpperCase() : '*',
        path,
        name: null,
        // Line of the path ARGUMENT, not the `new Request(` call — same
        // choice the other three consumer patterns in this file make, but
        // this is the one pattern where the two routinely differ (generated
        // clients wrap the call across multiple lines). Line-span
        // containment still resolves to the right symbol either way.
        line: pathArg.startPosition.row + 1,
        confidence: 0.6,
      });
    }

    return out;
  },
};
