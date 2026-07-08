import type Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import { normalizeExtractedRoutePath } from '../../../ingestion/route-extractors/route-path.js';
import {
  extractPythonModuleConstants,
  parseConstOperands,
  resolveOperands,
  type ModuleConstants,
  type Operand,
} from '../../../ingestion/route-extractors/python-const-resolver.js';
import type { HttpDetection, HttpLanguagePlugin, RepoContext } from './types.js';

/**
 * Python HTTP plugin. Handles:
 *   - FastAPI `@app.get("/path")` provider decorators
 *   - Django `path("route/", view)` provider calls
 *   - `requests.get/post/...("url")` consumer calls
 *   - Generic `requests.request("METHOD", "url")` consumer calls
 *   - `httpx.AsyncClient` instances calling `.get/.post/...("url")`, including
 *     aliased imports such as `import httpx as hx`,
 *     `from httpx import AsyncClient`, and
 *     `from httpx import AsyncClient as HttpxAsyncClient`.
 *     Locally rebound names (e.g. `AsyncClient = mock_factory()` inside a
 *     function) are excluded to avoid false-positive consumer contracts.
 */

const FASTAPI_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

// ─── Provider: FastAPI @app.<verb> / @router.<verb> ──────────────────
// Two separate patterns so we can tag detections by decorator object.
// Only `@router.*` detections participate in `include_router(prefix=)`
// path-prefix joining (see `PythonRepoContext` + `joinPrefix`); `@app.*`
// routes already carry their final path verbatim.
const FASTAPI_APP_PATTERNS = compilePatterns({
  name: 'python-fastapi-app',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (decorator
          (call
            function: (attribute
              object: (identifier) @obj (#eq? @obj "app")
              attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch)$"))
            arguments: (argument_list . (string) @path)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// NOTE: Django providers are NOT extracted by this per-file source scan.
// A standalone scan of `path()`/`re_path()` calls cannot tell a route from an
// `include()` mount point, nor compose the include() prefix across files, so it
// emitted bogus fragments (e.g. `/api` for a mount and `/items` un-prefixed
// instead of the real `/api/items`). Django provider contracts come from the
// graph Route nodes, which the ingestion route extractor builds with the
// includes already composed.

const FASTAPI_ROUTER_PATTERNS = compilePatterns({
  name: 'python-fastapi-router',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (decorator
          (call
            function: (attribute
              object: (identifier) @obj (#eq? @obj "router")
              attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch)$"))
            arguments: (argument_list . (string) @path)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// #2391: `@router.<verb>` / `@app.<verb>` whose first argument is a non-literal
// path — a bare imported constant or a `+`-concatenation. The path is resolved
// against the repo-wide constant map (parity with the ingestion side) and, on
// failure, the route is skipped (no provider contract) exactly like ingestion.
const FASTAPI_ROUTER_EXPR_PATTERNS = compilePatterns({
  name: 'python-fastapi-router-expr',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (decorator
          (call
            function: (attribute
              object: (identifier) @obj (#eq? @obj "router")
              attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch)$"))
            arguments: (argument_list . [(identifier) (binary_operator)] @path)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const FASTAPI_APP_EXPR_PATTERNS = compilePatterns({
  name: 'python-fastapi-app-expr',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (decorator
          (call
            function: (attribute
              object: (identifier) @obj (#eq? @obj "app")
              attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch)$"))
            arguments: (argument_list . [(identifier) (binary_operator)] @path)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Provider: Flask `app.add_url_rule('/path', view_func=handler)` ───
// The imperative Flask route registration: unlike `@app.route` (whose handler
// is the decorated function, same-file), `view_func` is frequently an IMPORTED
// (and sometimes aliased) view, so the handler resolves through the file's
// imports. `add_url_rule` + a `view_func=` keyword is highly Flask-specific, so
// the false-positive risk is low. Method(s) come from a `methods=[...]` keyword
// (default GET), extracted in code from the captured call.
const FLASK_ADD_URL_RULE_PATTERNS = compilePatterns({
  name: 'python-flask-add-url-rule',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            attribute: (identifier) @fn (#eq? @fn "add_url_rule"))
          arguments: (argument_list
            . (string) @path
            (keyword_argument
              name: (identifier) @kw (#eq? @kw "view_func")
              value: (identifier) @handler))) @call
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── include_router(<router_obj>, prefix='/x') across the repo ────────
// Two shapes are common:
//   app.include_router(assistant.router, prefix='/ai')
//   app.include_router(my_router, prefix='/ai')
// The first names the originating module via `<module>.router`; the second
// references a name imported into the host file. We capture both.
const INCLUDE_ROUTER_ATTR_PATTERNS = compilePatterns({
  name: 'python-fastapi-include-router-attr',
  language: Python,
  patterns: [
    {
      meta: {},
      // Match any `<host>.include_router(<module>.router, ..., prefix='/x')`
      // call. We deliberately do NOT pin `<host>` to the literal name `app`
      // — production code routinely uses `api`, `application`, `asgi_app`,
      // etc. The shape (`include_router` invoked with a router argument and
      // a `prefix=` keyword) is specific enough on its own; restricting the
      // host produces false negatives without removing meaningful false
      // positives.
      query: `
        (call
          function: (attribute
            attribute: (identifier) @incl (#eq? @incl "include_router"))
          arguments: (argument_list
            (attribute
              object: (identifier) @router_module
              attribute: (identifier) @router_attr (#eq? @router_attr "router"))
            (keyword_argument
              name: (identifier) @kw (#eq? @kw "prefix")
              value: (string) @prefix)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const INCLUDE_ROUTER_NAME_PATTERNS = compilePatterns({
  name: 'python-fastapi-include-router-name',
  language: Python,
  patterns: [
    {
      meta: {},
      // Same `<host>` rationale as INCLUDE_ROUTER_ATTR_PATTERNS — see above.
      query: `
        (call
          function: (attribute
            attribute: (identifier) @incl (#eq? @incl "include_router"))
          arguments: (argument_list
            (identifier) @router_name
            (keyword_argument
              name: (identifier) @kw (#eq? @kw "prefix")
              value: (string) @prefix)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const API_ROUTER_PREFIX_PATTERNS = compilePatterns({
  name: 'python-fastapi-apirouter-prefix',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (assignment
          left: (identifier) @router_name (#eq? @router_name "router")
          right: (call
            function: (identifier) @factory (#eq? @factory "APIRouter")
            arguments: (argument_list
              (keyword_argument
                name: (identifier) @kw (#eq? @kw "prefix")
                value: (string) @prefix))))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// `from .api.assistant import router` style — used together with
// INCLUDE_ROUTER_NAME so we can map a local name back to its module
// path, then back to the file the router was declared in.
const FROM_IMPORT_ROUTER_PATTERNS = compilePatterns({
  name: 'python-fastapi-from-import-router',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (import_from_statement
          module_name: (_) @module
          name: (dotted_name (identifier) @imported (#eq? @imported "router")))
      `,
    },
    {
      meta: {},
      query: `
        (import_from_statement
          module_name: (_) @module
          name: (aliased_import
            name: (dotted_name (identifier) @imported (#eq? @imported "router"))
            alias: (identifier) @alias))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// `from api import users` / `from api import users as u` — module-level
// imports where the imported name is itself the module that owns
// `<name>.router`. Lets Shape A (`<host>.include_router(<name>.router, …)`)
// look up the full package path of `<name>` and pin the prefix onto the
// exact file (`api/users.py`) rather than every file basenamed `users.py`.
const FROM_IMPORT_MODULE_PATTERNS = compilePatterns({
  name: 'python-fastapi-from-import-module',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (import_from_statement
          module_name: (_) @module
          name: (dotted_name (identifier) @imported))
      `,
    },
    {
      meta: {},
      query: `
        (import_from_statement
          module_name: (_) @module
          name: (aliased_import
            name: (dotted_name (identifier) @imported)
            alias: (identifier) @alias))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: requests.get/post/...("literal") ──────────────────────
const REQUESTS_VERB_PATTERNS = compilePatterns({
  name: 'python-requests-verb',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "requests")
            attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch)$"))
          arguments: (argument_list . (string) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: requests.get/post/...(url=VALUE) keyword ──────────────
const REQUESTS_KEYWORD_URL_PATTERNS = compilePatterns({
  name: 'python-requests-keyword-url',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "requests")
            attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch)$"))
          arguments: (argument_list
            (keyword_argument
              name: (identifier) @kw (#eq? @kw "url")
              value: (string) @path)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: requests.request("METHOD", "url") ─────────────────────
const REQUESTS_GENERIC_PATTERNS = compilePatterns({
  name: 'python-requests-generic',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (identifier) @obj (#eq? @obj "requests")
            attribute: (identifier) @method (#eq? @method "request"))
          arguments: (argument_list . (string) @http_method (string) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: wrapper classes with uri= or url= keyword argument ──────
// Common pattern: wrapper classes like RequestFetch that accept URL via
// named argument instead of positional argument:
//   obj.fetch(uri="api/v1/camera/info/")
//   obj.get(url="api/v1/camera/info/")
//   obj.post(uri="api/v1/config/update/")
const WRAPPER_URI_PATTERNS = compilePatterns({
  name: 'python-http-wrapper-uri',
  language: Python,
  patterns: [
    {
      meta: {},
      // Match any method call where keyword argument is `uri` or `url`
      query: `
        (call
          function: (attribute
            object: (_) @client
            attribute: (identifier) @method)
          arguments: (argument_list
            (keyword_argument
              name: (identifier) @kw (#match? @kw "^(uri|url)$")
              value: (string) @path)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Map wrapper method names to HTTP verbs
const WRAPPER_METHOD_TO_HTTP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
  fetch: 'GET',
  request: 'GET',
};

// ─── Variable-to-string propagation patterns ─────────────────────────
// Many repos assign URL paths to local variables then pass them as
// keyword arguments: uri = "api/v1/endpoint/"; obj.fetch(uri=uri, body)
// These patterns + buildLocalStringMap resolve the variable → literal chain.

// Track local string constants: uri = "api/v1/endpoint/"
const LOCAL_STRING_ASSIGNMENTS = compilePatterns({
  name: 'python-local-string-assign',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (assignment
          left: (identifier) @var_name
          right: (string) @var_value)
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Match method calls where uri=/url= value is a variable that was previously
// assigned a string literal
const WRAPPER_URI_VAR_PATTERNS = compilePatterns({
  name: 'python-http-wrapper-uri-var',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (_) @client
            attribute: (identifier) @method)
          arguments: (argument_list
            (keyword_argument
              name: (identifier) @kw (#match? @kw "^(uri|url)$")
              value: (identifier) @path_var)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

/**
 * Map each `from <module> import <name> [as <alias>]` binding to its declared
 * name + raw module specifier (the spec keeps the leading dots for relative
 * imports — `.users`, `..pkg.users` — which the extractor resolves to a target
 * file). Lets a Flask `view_func` handler resolve through an alias to the real
 * symbol in its module rather than the local alias text. `import x` / `import x
 * as y` (module imports, not symbol imports) are left out — a route handler is a
 * symbol, addressed via `from … import …`.
 */
function buildPythonImportMap(tree: Parser.Tree): Map<string, { name: string; module: string }> {
  const map = new Map<string, { name: string; module: string }>();
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      const module = moduleNode?.text ?? null;
      if (module !== null) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (!c || c.id === moduleNode?.id) continue;
          if (c.type === 'dotted_name') {
            map.set(c.text, { name: c.text, module });
          } else if (c.type === 'aliased_import') {
            const nameNode = c.childForFieldName('name');
            const aliasNode = c.childForFieldName('alias');
            if (nameNode && aliasNode) {
              map.set(aliasNode.text, { name: nameNode.text, module });
            }
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) walk(c);
    }
  };
  walk(tree.rootNode);
  return map;
}

/**
 * HTTP verbs declared on a Flask `add_url_rule(..., methods=[...])` call, upper-
 * cased. Defaults to `['GET']` when no `methods` keyword is present (Flask's own
 * default). Reads the captured call node directly since the list value is awkward
 * to capture in a tree-sitter query.
 */
function extractFlaskMethods(callNode: Parser.SyntaxNode): string[] {
  const args = callNode.childForFieldName('arguments');
  if (args) {
    for (let i = 0; i < args.namedChildCount; i++) {
      const kw = args.namedChild(i);
      if (!kw || kw.type !== 'keyword_argument') continue;
      if (kw.childForFieldName('name')?.text !== 'methods') continue;
      const list = kw.childForFieldName('value');
      if (!list) continue;
      const methods: string[] = [];
      for (let j = 0; j < list.namedChildCount; j++) {
        const el = list.namedChild(j);
        const v = el && el.type === 'string' ? unquoteLiteral(el.text) : null;
        if (v) methods.push(v.toUpperCase());
      }
      if (methods.length > 0) return methods;
    }
  }
  return ['GET'];
}

// Pre-scan: collect local string assignments (uri = "api/v1/endpoint/")
function buildLocalStringMap(tree: Parser.Tree): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of runCompiledPatterns(LOCAL_STRING_ASSIGNMENTS, tree)) {
    const varNode = match.captures.var_name;
    const valNode = match.captures.var_value;
    if (!varNode || !valNode) continue;
    const val = unquoteLiteral(valNode.text);
    if (val === null) continue;
    map.set(varNode.text, val);
  }
  return map;
}

// ─── Consumer: httpx.AsyncClient assignments ────────────────────────
// Module-scope clients are only matched
// at module scope; calls inside functions require a function/class-local tracked
// client to avoid false positives from same-name local variables.
const HTTPX_MODULE_IMPORT_PATTERNS = compilePatterns({
  name: 'python-httpx-module-imports',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (import_statement
          name: (aliased_import
            name: (dotted_name (identifier) @module)
            alias: (identifier) @alias))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const HTTPX_ASYNC_CLIENT_IMPORT_PATTERNS = compilePatterns({
  name: 'python-httpx-async-client-imports',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (import_from_statement
          module_name: (dotted_name (identifier) @module)
          name: (dotted_name (identifier) @client_class))
      `,
    },
    {
      meta: {},
      query: `
        (import_from_statement
          module_name: (dotted_name (identifier) @module)
          name: (aliased_import
            name: (dotted_name (identifier) @client_class)
            alias: (identifier) @alias))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const HTTPX_ASYNC_CLIENT_ASSIGN_PATTERNS = compilePatterns({
  name: 'python-httpx-async-client-assign',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (assignment
          left: (_) @client
          right: (call
            function: (attribute
              object: (identifier) @module
              attribute: (identifier) @client_class)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const HTTPX_ASYNC_CLIENT_DIRECT_ASSIGN_PATTERNS = compilePatterns({
  name: 'python-httpx-async-client-direct-assign',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (assignment
          left: (_) @client
          right: (call
            function: (identifier) @client_class))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: async with httpx.AsyncClient() as client ──────────────
const HTTPX_ASYNC_CLIENT_WITH_ALIAS_PATTERNS = compilePatterns({
  name: 'python-httpx-async-client-with-alias',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (as_pattern
          (call
            function: (attribute
              object: (identifier) @module
              attribute: (identifier) @client_class))
          (as_pattern_target (identifier) @client))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const HTTPX_ASYNC_CLIENT_DIRECT_WITH_ALIAS_PATTERNS = compilePatterns({
  name: 'python-httpx-async-client-direct-with-alias',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (as_pattern
          (call
            function: (identifier) @client_class)
          (as_pattern_target (identifier) @client))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

function getScopeKey(node: Parser.SyntaxNode | null, preferClass = false): string {
  if (preferClass) {
    let current: Parser.SyntaxNode | null = node;
    while (current) {
      if (current.type === 'class_definition') {
        return `class:${current.startIndex}:${current.endIndex}`;
      }
      current = current.parent;
    }
  }

  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === 'function_definition') {
      return `function:${current.startIndex}:${current.endIndex}`;
    }
    current = current.parent;
  }

  return 'module';
}

function trackedClientScopeKey(clientNode: Parser.SyntaxNode): string {
  return getScopeKey(clientNode.parent, clientNode.text.includes('.'));
}

function callScopeKeys(clientNode: Parser.SyntaxNode): string[] {
  return [getScopeKey(clientNode.parent, clientNode.text.includes('.'))];
}

// Returns the scope key that a rebind of an imported alias would shadow under
// Python LEGB rules, or `null` when the rebind does not shadow anything that
// could produce a false-positive consumer detection.
//   - Rebind inside a function/method → that function's scope.
//   - Rebind at module top level → 'module' (shadows the whole file).
//   - Rebind in a class body without an enclosing function → null. Python
//     class attributes do not shadow bare-name lookups inside methods (methods
//     see the module binding, not the class attribute), so we must not poison
//     them.
function shadowScopeKey(node: Parser.SyntaxNode | null): string | null {
  let current = node;
  let passedThroughClass = false;
  while (current) {
    if (current.type === 'function_definition') {
      // Reuse getScopeKey's key format so the two helpers cannot drift apart.
      return getScopeKey(current);
    }
    if (current.type === 'class_definition') {
      passedThroughClass = true;
    }
    current = current.parent;
  }
  return passedThroughClass ? null : 'module';
}

function collectHttpxImportAliases(tree: Parser.Tree): {
  moduleAliases: Set<string>;
  asyncClientAliases: Set<string>;
} {
  const moduleAliases = new Set<string>(['httpx']);
  const asyncClientAliases = new Set<string>();

  // The @module capture is a single identifier inside a `dotted_name`, so for
  // `import package.httpx as hx` the pattern would match the inner `httpx`
  // segment. Check the full `dotted_name` text via `parent` to anchor the match.
  for (const match of runCompiledPatterns(HTTPX_MODULE_IMPORT_PATTERNS, tree)) {
    const moduleNode = match.captures.module;
    const aliasNode = match.captures.alias;
    if (moduleNode?.parent?.text === 'httpx' && aliasNode) moduleAliases.add(aliasNode.text);
  }

  for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_IMPORT_PATTERNS, tree)) {
    const moduleNode = match.captures.module;
    const classNode = match.captures.client_class;
    if (moduleNode?.parent?.text !== 'httpx' || classNode?.text !== 'AsyncClient') continue;
    asyncClientAliases.add(match.captures.alias?.text ?? classNode.text);
  }

  return { moduleAliases, asyncClientAliases };
}

// Tracks local rebindings (`AsyncClient = ...`, `hx = ...`) that shadow an
// imported alias. We treat the whole enclosing scope (module, class, or
// function) as shadowed for that alias name, so subsequent constructions in
// that scope are not falsely detected as httpx consumers. Covers bare-identifier
// targets and the common tuple / list destructuring shapes.
const ALIAS_SHADOW_PATTERNS = compilePatterns({
  name: 'python-httpx-alias-shadow',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `(assignment left: (identifier) @name)`,
    },
    {
      meta: {},
      query: `(assignment left: (pattern_list (identifier) @name))`,
    },
    {
      meta: {},
      query: `(assignment left: (tuple_pattern (identifier) @name))`,
    },
    {
      meta: {},
      query: `(assignment left: (list_pattern (identifier) @name))`,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

function collectAliasShadowScopes(
  tree: Parser.Tree,
  aliases: Set<string>,
): Map<string, Set<string>> {
  const shadowed = new Map<string, Set<string>>();
  if (aliases.size === 0) return shadowed;

  for (const match of runCompiledPatterns(ALIAS_SHADOW_PATTERNS, tree)) {
    const nameNode = match.captures.name;
    if (!nameNode || !aliases.has(nameNode.text)) continue;
    const scopeKey = shadowScopeKey(nameNode.parent);
    if (scopeKey === null) continue;
    const set = shadowed.get(nameNode.text) ?? new Set<string>();
    set.add(scopeKey);
    shadowed.set(nameNode.text, set);
  }

  return shadowed;
}

function isAliasShadowed(
  shadowed: Map<string, Set<string>>,
  aliasName: string,
  node: Parser.SyntaxNode,
): boolean {
  const scopes = shadowed.get(aliasName);
  if (!scopes || scopes.size === 0) return false;
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'function_definition') {
      // Reuse getScopeKey's key format so the two helpers cannot drift apart.
      if (scopes.has(getScopeKey(current))) return true;
    }
    current = current.parent;
  }
  // A module-level rebind shadows the alias for the entire file.
  return scopes.has('module');
}

function collectHttpxAsyncClients(tree: Parser.Tree): Map<string, Set<string>> {
  const clients = new Map<string, Set<string>>();
  const { moduleAliases, asyncClientAliases } = collectHttpxImportAliases(tree);
  // Module aliases (`hx`) and AsyncClient aliases (`AsyncClient`,
  // `HttpxAsyncClient`) share disjoint name spaces, so one shadow map keyed by
  // alias name serves both lookups and we only walk the tree for rebinds once.
  const shadowed = collectAliasShadowScopes(
    tree,
    new Set([...moduleAliases, ...asyncClientAliases]),
  );

  const addClient = (clientNode: Parser.SyntaxNode | undefined) => {
    if (!clientNode) return;
    const scopeKey = trackedClientScopeKey(clientNode);
    const clientText = clientNode.text;
    const scopes = clients.get(clientText) ?? new Set<string>();
    scopes.add(scopeKey);
    clients.set(clientText, scopes);
  };

  for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_ASSIGN_PATTERNS, tree)) {
    const moduleNode = match.captures.module;
    const classNode = match.captures.client_class;
    if (!moduleNode || !classNode) continue;
    if (!moduleAliases.has(moduleNode.text) || classNode.text !== 'AsyncClient') continue;
    if (isAliasShadowed(shadowed, moduleNode.text, moduleNode)) continue;
    addClient(match.captures.client);
  }

  for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_DIRECT_ASSIGN_PATTERNS, tree)) {
    const classNode = match.captures.client_class;
    if (!classNode || !asyncClientAliases.has(classNode.text)) continue;
    if (isAliasShadowed(shadowed, classNode.text, classNode)) continue;
    addClient(match.captures.client);
  }

  for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_WITH_ALIAS_PATTERNS, tree)) {
    const moduleNode = match.captures.module;
    const classNode = match.captures.client_class;
    if (!moduleNode || !classNode) continue;
    if (!moduleAliases.has(moduleNode.text) || classNode.text !== 'AsyncClient') continue;
    if (isAliasShadowed(shadowed, moduleNode.text, moduleNode)) continue;
    addClient(match.captures.client);
  }

  for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_DIRECT_WITH_ALIAS_PATTERNS, tree)) {
    const classNode = match.captures.client_class;
    if (!classNode || !asyncClientAliases.has(classNode.text)) continue;
    if (isAliasShadowed(shadowed, classNode.text, classNode)) continue;
    addClient(match.captures.client);
  }

  return clients;
}

function hasTrackedHttpxAsyncClient(
  clients: Map<string, Set<string>>,
  clientNode: Parser.SyntaxNode,
): boolean {
  const scopes = clients.get(clientNode.text);
  if (!scopes) return false;

  return callScopeKeys(clientNode).some((scopeKey) => scopes.has(scopeKey));
}

// ─── Consumer: httpx AsyncClient .get/.post/...("url") ──────────────
const HTTPX_ASYNC_CLIENT_VERB_PATTERNS = compilePatterns({
  name: 'python-httpx-async-client-verb',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (_) @client
            attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch)$"))
          arguments: (argument_list . (string) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: httpx AsyncClient .request("METHOD", "url") ─────────
const HTTPX_ASYNC_CLIENT_GENERIC_PATTERNS = compilePatterns({
  name: 'python-httpx-async-client-generic',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (_) @client
            attribute: (identifier) @method (#eq? @method "request"))
          arguments: (argument_list . (string) @http_method (string) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── prepareRepo: build router-module → prefix list map ─────────────
//
// FastAPI splits route declarations across files: handler decorators
// live in `api/<feature>.py` while `app.include_router(<x>.router,
// prefix='/ai')` lives in `main.py`. A per-file plugin scan therefore
// can't see the prefix that ought to be applied. We resolve this by
// running a one-shot pre-pass over the repo: for every file that
// hosts an `app.include_router(...)` we record the module the router
// came from (either via `module.router` attribute access, or via a
// local name resolved through a `from <module> import router` import)
// together with the prefix string. At scan time the python plugin
// looks up the current file's module key in this map and joins each
// prefix with each `@router.<verb>` decorator's path.
//
// Multiple prefixes for the same module are kept and emitted as
// separate detections — this matches FastAPI's behaviour when one
// router is mounted under several prefixes.
//
// Module keying is two-tiered to avoid prefix bleed between same-named
// files in different packages (e.g. `api/users.py` vs `admin/users.py`):
//   • short key — file basename without `.py`           (`users`)
//   • long  key — `<parent-dir>/<basename>`             (`api/users`)
// The pre-pass records prefixes against the long key whenever the import
// site supplies enough context (`from api.users import router as ...` →
// long key `api/users`); otherwise it falls back to the short key.
// At scan time the file's own long key is consulted first; only when no
// long-key entry targets this file do we look up the short key. This
// preserves the previous coarse-grained behaviour where context is
// missing while delivering precision wherever the import statement
// gives us a multi-segment module path.
interface PythonRepoContext {
  /** `<parent>/<stem>` → set of prefixes (precise, package-aware) */
  prefixesByLongKey: Map<string, Set<string>>;
  /** stem only → set of prefixes (basename fallback, may collide) */
  prefixesByShortKey: Map<string, Set<string>>;
  /**
   * File-path-keyed module string constants (#2391), for resolving non-literal
   * `@router`/`@app` decorator paths. Empty when the repo has no composed-constant
   * route (cost gate). Keyed identically to the ingestion aggregate so provider
   * contracts and graph Route nodes resolve the same paths (R4 parity).
   */
  constantsByFile: Map<string, ModuleConstants>;
}

/** Strip `.py` and return the bare basename (e.g. `api/users.py` → `users`). */
function fileShortKey(rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return file.endsWith('.py') ? file.slice(0, -3) : file;
}

/**
 * Long key for a `.py` file: parent directory + stem, joined with `/`.
 * Files at the repo root return the empty string (no parent), in which
 * case callers should fall back to the short key.
 */
function fileLongKey(rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  const noExt = normalized.endsWith('.py') ? normalized.slice(0, -3) : normalized;
  const lastSlash = noExt.lastIndexOf('/');
  if (lastSlash < 0) return '';
  const beforeLast = noExt.slice(0, lastSlash);
  const stem = noExt.slice(lastSlash + 1);
  const prevSlash = beforeLast.lastIndexOf('/');
  const parent = prevSlash >= 0 ? beforeLast.slice(prevSlash + 1) : beforeLast;
  return `${parent}/${stem}`;
}

/** Last `.`-separated segment of a (possibly relative) module path. */
function lastSegmentOfDotted(text: string): string {
  const stripped = text.replace(/^\.+/, '');
  if (!stripped) return '';
  const dot = stripped.lastIndexOf('.');
  return dot >= 0 ? stripped.slice(dot + 1) : stripped;
}

/**
 * Last two `.`-separated segments of a (possibly relative) module path
 * joined with `/`, e.g. `api.users` → `api/users`. Single-segment paths
 * and pure-dot inputs return the empty string; callers should fall back
 * to the short key in that case.
 */
function lastTwoSegmentsAsLongKey(text: string): string {
  const stripped = text.replace(/^\.+/, '');
  if (!stripped) return '';
  const last = stripped.lastIndexOf('.');
  if (last <= 0) return '';
  const beforeLast = stripped.slice(0, last);
  const stem = stripped.slice(last + 1);
  const prev = beforeLast.lastIndexOf('.');
  const parent = prev >= 0 ? beforeLast.slice(prev + 1) : beforeLast;
  return `${parent}/${stem}`;
}

function recordPrefix(target: Map<string, Set<string>>, key: string, prefix: string): void {
  const set = target.get(key) ?? new Set<string>();
  set.add(prefix);
  target.set(key, set);
}

// Cheap cost-gate pre-filter: a `@router`/`@app.<verb>(` call whose first
// argument is non-literal — either it STARTS with an identifier (a bare constant
// or the head of `CONST + "/x"`), or it is a string-literal-LEADING concat
// (`"/api" + SUFFIX`) detected by a `+` before the decorator's closing paren
// (#2393). `[^)]*` spans the whole argument, including a Black-formatted concat
// that wraps across lines, but stays bounded by the decorator's own `)`. Gating
// the literal-leading case on the `+` (not merely a leading quote) keeps a plain
// string route `@router.get("/x")` OFF the gate, so a literal-only repo pays no
// parse pass. Deliberately loose — a false positive only costs a parse; a false
// negative would silently drop the feature.
const NONLITERAL_ROUTE_DECORATOR_RE =
  /@\s*(?:app|router)\s*\.\s*(?:get|post|put|delete|patch)\s*\(\s*(?:[A-Za-z_]|["'][^)]*\+)/;

function buildPythonRepoContext(
  files: string[],
  parser: Parser,
  readFile: (rel: string) => string | null,
  parseSource: (parser: Parser, src: string) => Parser.Tree | null,
): PythonRepoContext {
  const prefixesByLongKey = new Map<string, Set<string>>();
  const prefixesByShortKey = new Map<string, Set<string>>();

  // Single read pass (#2393): slurp every `.py` file's content ONCE. This used to
  // be two passes — the include_router pre-pass below and the #2391 constant cost
  // gate each re-read every `.py` file. The composed-route cost gate is computed
  // in the same pass so a literal-only repo still does exactly one read and zero
  // parses.
  const pyContents = new Map<string, string>();
  let hasComposedRoute = false;
  for (const rel of files) {
    if (!rel.endsWith('.py')) continue;
    const src = readFile(rel);
    if (!src) continue;
    pyContents.set(rel, src);
    if (!hasComposedRoute && NONLITERAL_ROUTE_DECORATOR_RE.test(src)) hasComposedRoute = true;
  }

  // Single PARSE pass (#2391): parse each `.py` at most once and feed BOTH the
  // include_router prefix pre-pass and the composed-constant map below. This used
  // to be two loops, so an include_router file in a composed repo was parsed
  // twice. A file that needs neither pass is not parsed at all (cost gates intact).
  //
  // Cross-file pre-pass: only `include_router` sites need it — they bind a prefix
  // declared in one file to a router defined in another. Same-file
  // `APIRouter(prefix=...)` is resolved in scan() from the file's own tree.
  const constantsByFile = new Map<string, ModuleConstants>();
  for (const [rel, src] of pyContents) {
    const needsRouter = src.includes('include_router');
    if (!needsRouter && !hasComposedRoute) continue;
    parser.setLanguage(Python);
    const tree = parseSource(parser, src);
    if (!tree) continue;

    if (needsRouter) {
      // Local name → (short, long) map for the current file, populated
      // from `from <module> import router [as <alias>]` statements. The
      // alias (or 'router' when there is no alias) is the local name
      // we'll later see passed to `<host>.include_router`.
      interface LocalImport {
        moduleShort: string;
        moduleLong: string;
      }
      const localNameToModule = new Map<string, LocalImport>();
      for (const m of runCompiledPatterns(FROM_IMPORT_ROUTER_PATTERNS, tree)) {
        const moduleNode = m.captures.module;
        const aliasNode = m.captures.alias;
        const importedNode = m.captures.imported;
        if (!moduleNode || !importedNode) continue;
        const localName = aliasNode?.text ?? importedNode.text;
        const moduleShort = lastSegmentOfDotted(moduleNode.text);
        if (!moduleShort) continue;
        const moduleLong = lastTwoSegmentsAsLongKey(moduleNode.text);
        localNameToModule.set(localName, { moduleShort, moduleLong });
      }

      // Module-alias map: name imported from a multi-segment package →
      // long key. Lets Shape A look up the precise file for `<name>.router`
      // even when `<name>` collides with another package's basename.
      const localNameToModuleAlias = new Map<string, string>();
      for (const m of runCompiledPatterns(FROM_IMPORT_MODULE_PATTERNS, tree)) {
        const moduleNode = m.captures.module;
        const importedNode = m.captures.imported;
        const aliasNode = m.captures.alias;
        if (!moduleNode || !importedNode) continue;
        // Skip the `router` shape — already handled by FROM_IMPORT_ROUTER_PATTERNS
        // above and stored under its router-aware semantics.
        if (importedNode.text === 'router') continue;
        const moduleLong = lastTwoSegmentsAsLongKey(`${moduleNode.text}.${importedNode.text}`);
        if (!moduleLong) continue;
        const localName = aliasNode?.text ?? importedNode.text;
        localNameToModuleAlias.set(localName, moduleLong);
      }

      // Shape A: `<host>.include_router(<module>.router, prefix='/x')`.
      // The call site gives us only a short module name. We promote to a
      // long key when the same file imports `<module>` via either
      // `from <pkg> import <module>` (recorded in `localNameToModuleAlias`
      // — the typical pattern) or, less commonly, a router-aware import
      // statement. Only fall back to the basename short key when neither
      // alias is available.
      for (const m of runCompiledPatterns(INCLUDE_ROUTER_ATTR_PATTERNS, tree)) {
        const modNode = m.captures.router_module;
        const prefixNode = m.captures.prefix;
        if (!modNode || !prefixNode) continue;
        const prefix = unquoteLiteral(prefixNode.text);
        if (prefix === null) continue;
        const moduleShort = modNode.text;
        const aliasLong = localNameToModuleAlias.get(moduleShort);
        const sameFileImport = localNameToModule.get(moduleShort);
        const longKey = aliasLong ?? sameFileImport?.moduleLong;
        if (longKey) {
          recordPrefix(prefixesByLongKey, longKey, prefix);
        } else {
          recordPrefix(prefixesByShortKey, moduleShort, prefix);
        }
      }

      // Shape B: `<host>.include_router(my_router, prefix='/x')` — resolve
      // `my_router` via the import map built above. Whenever the import
      // statement supplied a multi-segment module path the long key is
      // recorded, eliminating cross-package collisions.
      for (const m of runCompiledPatterns(INCLUDE_ROUTER_NAME_PATTERNS, tree)) {
        const nameNode = m.captures.router_name;
        const prefixNode = m.captures.prefix;
        if (!nameNode || !prefixNode) continue;
        const localImp = localNameToModule.get(nameNode.text);
        if (!localImp) continue;
        const prefix = unquoteLiteral(prefixNode.text);
        if (prefix === null) continue;
        if (localImp.moduleLong) {
          recordPrefix(prefixesByLongKey, localImp.moduleLong, prefix);
        } else {
          recordPrefix(prefixesByShortKey, localImp.moduleShort, prefix);
        }
      }
    }

    // #2391: build the repo-wide constant map for resolving non-literal decorator
    // paths (KTD6 cost gate: only when `hasComposedRoute`). Parse EVERY `.py` so
    // the resolvable set matches the ingestion aggregate (R4 parity) — a narrower
    // set would return null where ingestion resolves.
    if (hasComposedRoute) {
      const mc = extractPythonModuleConstants(tree);
      if (mc.literals.size > 0 || mc.exprs.size > 0 || mc.imports.size > 0) {
        constantsByFile.set(rel, mc);
      }
    }
  }

  return {
    prefixesByLongKey,
    prefixesByShortKey,
    constantsByFile,
  };
}

function joinPrefix(prefix: string, route: string): string {
  // Delegate to the shared route-path normalizer so the group contract and the
  // ingestion Route node join prefixes identically — one helper, no
  // trailing-slash drift on empty routes (`APIRouter(prefix="/x")` + `@get("")`).
  return normalizeExtractedRoutePath(route, prefix);
}
export const PYTHON_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'python-http',
  language: Python,
  // routeCoverage intentionally LEFT at the default 'partial' (#2138 Part 2).
  // It would be a no-op even if set to 'complete': FastAPI decorator routes set
  // no handlerName (generic worker path) and Django sets methodName: null, so no
  // Python file ever resolves a handlerSymbolId and none would be parse-skipped.
  // Declaring 'complete' now is only a latent trap for the moment a follow-up
  // gives FastAPI routes a handlerName. `hasConsumerSignals` is kept (and is a
  // true superset of scan()'s consumer shapes) so the precondition already holds
  // when Python is later flipped to 'complete'.
  // Consumer signals scan() can detect: `requests.<verb>`/`requests.request`,
  // `httpx` (sync/async client), the `uri=`/`url=` keyword/variable wrapper
  // calls, plus aiohttp/urllib. Conservative — over-matching only costs a parse.
  hasConsumerSignals(content) {
    return /\brequests\s*\.|\bhttpx\b|\baiohttp\b|\burllib\b|\burlopen\b|\buri\s*=|\burl\s*=/.test(
      content,
    );
  },
  prepareRepo({ files, parser, readFile, parseSource }): RepoContext {
    return buildPythonRepoContext(files, parser, readFile, parseSource);
  },
  scan(tree, repoContext, fileRel) {
    const out: HttpDetection[] = [];
    const httpxAsyncClients = collectHttpxAsyncClients(tree);
    const ctx = repoContext as PythonRepoContext | undefined;
    // Local-binding → { declared name, module } for the file's `from … import …`
    // statements, so an imperatively-registered handler (Flask `view_func`) that
    // is an imported (possibly aliased) symbol resolves to its real definition.
    const importMap = buildPythonImportMap(tree);

    // #2391: fold a non-literal decorator argument (bare constant or
    // `+`-concatenation) to its literal path against the repo constant map, or
    // `null` → skip (the same floor the ingestion side applies, so provider
    // contracts and graph Route nodes agree on both resolved and dropped routes).
    const resolveExprArg = (argNode: Parser.SyntaxNode): string | null => {
      const cbf = ctx?.constantsByFile;
      if (!cbf || !fileRel) return null;
      // Build an operand list and fold via `resolveOperands` — the SAME entry the
      // ingestion side uses (parse-impl folds `routePathOperands`). Using the
      // by-name `resolveConstant` here would enter `foldName` one depth shallower,
      // so at the MAX_RESOLVE_DEPTH boundary the group would resolve a chain
      // ingestion drops, breaking R4 parity (#2393).
      const operands: Operand[] | null =
        argNode.type === 'identifier'
          ? [{ kind: 'ref', name: argNode.text }]
          : parseConstOperands(argNode);
      return operands ? resolveOperands(fileRel, operands, cbf) : null;
    };
    const emitAppProvider = (httpMethod: string, pathVal: string, line: number): void => {
      out.push({
        role: 'provider',
        framework: 'fastapi',
        method: httpMethod,
        path: pathVal,
        name: null,
        // The decorated handler has no captured name → resolve by line-span
        // containment. Best-effort fallback: FastAPI routes are graph-backed
        // (ingestion decorator routes) and the function span starts at `def`
        // (decorators excluded), so this lands the single-decorator case and
        // degrades to file-level for multi-decorator stacks.
        line,
        confidence: 0.8,
      });
    };

    // Providers: FastAPI @app.<verb>("/path") — already absolute path.
    for (const match of runCompiledPatterns(FASTAPI_APP_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const httpMethod = FASTAPI_VERBS[methodNode.text];
      if (!httpMethod) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      emitAppProvider(httpMethod, path, pathNode.startPosition.row + 1);
    }
    // Providers: FastAPI @app.<verb>(CONST | A + "/x") — resolved composed path.
    for (const match of runCompiledPatterns(FASTAPI_APP_EXPR_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const httpMethod = FASTAPI_VERBS[methodNode.text];
      if (!httpMethod) continue;
      const resolved = resolveExprArg(pathNode);
      if (resolved === null) continue; // skip floor
      emitAppProvider(httpMethod, resolved, pathNode.startPosition.row + 1);
    }

    // Django providers come from the graph Route nodes (includes composed by
    // the ingestion route extractor), not a per-file source scan — see the note
    // at the top of this file.

    // Same-file `router = APIRouter(prefix="/x")` (router-only). Read from this
    // file's own tree, so there is no cross-file map and no prefix bleed across
    // same-stem files; it stacks under any include_router(prefix=...) below.
    let constructorPrefix: string | undefined;
    for (const m of runCompiledPatterns(API_ROUTER_PREFIX_PATTERNS, tree)) {
      const prefixNode = m.captures.prefix;
      if (!prefixNode) continue;
      const p = unquoteLiteral(prefixNode.text);
      if (p === null) continue;
      constructorPrefix = p;
    }

    // Providers: FastAPI @router.<verb>("/path") — must be joined
    // with the prefix(es) declared at the include_router site. When
    // no prefix is found we still emit the unprefixed path so this
    // change is strictly additive vs. the prior @app-only behaviour;
    // when the same router is mounted under multiple prefixes we emit
    // one detection per prefix.
    // Join a `@router.<verb>` path with the include_router / APIRouter prefix(es)
    // that apply to this file and emit one provider detection per prefix. Shared
    // by the literal and the #2391 non-literal (resolved) router loops so both
    // stack prefixes identically.
    const emitRouterProvider = (httpMethod: string, rawPath: string, line: number): void => {
      // Long key first (precise, package-aware), short key as fallback.
      // Mirrors the ingestion-side resolution in parse-impl.ts so the
      // graph nodes and group contracts agree on which prefix applies.
      const longKey = fileRel ? fileLongKey(fileRel) : '';
      const longPrefixes = longKey ? ctx?.prefixesByLongKey.get(longKey) : undefined;
      const shortKey = fileRel ? fileShortKey(fileRel) : '';
      const shortPrefixes =
        longPrefixes || !shortKey ? undefined : ctx?.prefixesByShortKey.get(shortKey);
      const prefixSet = longPrefixes ?? shortPrefixes;
      // Stack the same-file APIRouter(prefix=...) under any cross-file
      // include_router prefix.
      const localPath = constructorPrefix ? joinPrefix(constructorPrefix, rawPath) : rawPath;
      const paths =
        prefixSet && prefixSet.size > 0
          ? [...prefixSet].map((p) => joinPrefix(p, localPath))
          : [localPath];

      for (const p of paths) {
        out.push({
          role: 'provider',
          framework: 'fastapi',
          method: httpMethod,
          path: p,
          name: null,
          // Best-effort containment fallback — see the @app provider note above.
          line,
          confidence: 0.8,
        });
      }
    };

    for (const match of runCompiledPatterns(FASTAPI_ROUTER_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const httpMethod = FASTAPI_VERBS[methodNode.text];
      if (!httpMethod) continue;
      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;
      emitRouterProvider(httpMethod, rawPath, pathNode.startPosition.row + 1);
    }
    // Providers: FastAPI @router.<verb>(CONST | A + "/x") — resolved composed path
    // (#2391). Null resolution → skip, so provider/graph parity holds.
    for (const match of runCompiledPatterns(FASTAPI_ROUTER_EXPR_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const httpMethod = FASTAPI_VERBS[methodNode.text];
      if (!httpMethod) continue;
      const resolved = resolveExprArg(pathNode);
      if (resolved === null) continue;
      emitRouterProvider(httpMethod, resolved, pathNode.startPosition.row + 1);
    }

    // Providers: Flask `app.add_url_rule('/path', view_func=handler, methods=[…])`.
    // The handler is a `view_func` identifier, frequently an imported (possibly
    // aliased) view, so resolve it through the file's imports to the declared
    // symbol + its module for import-pinned resolution downstream.
    for (const match of runCompiledPatterns(FLASK_ADD_URL_RULE_PATTERNS, tree)) {
      const pathNode = match.captures.path;
      const handlerNode = match.captures.handler;
      const callNode = match.captures.call;
      if (!pathNode || !handlerNode || !callNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      const imported = importMap.get(handlerNode.text);
      for (const method of extractFlaskMethods(callNode)) {
        out.push({
          role: 'provider',
          framework: 'flask',
          method,
          path,
          name: imported ? imported.name : handlerNode.text,
          handlerImport: imported,
          line: (imported ? pathNode : handlerNode).startPosition.row + 1,
          confidence: 0.8,
        });
      }
    }

    // Consumers: requests.<verb>
    for (const match of runCompiledPatterns(REQUESTS_VERB_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'python-requests',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // Consumers: requests.<verb>(url="literal") keyword
    for (const match of runCompiledPatterns(REQUESTS_KEYWORD_URL_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'python-requests',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // Consumers: requests.request("METHOD", "url")
    for (const match of runCompiledPatterns(REQUESTS_GENERIC_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const methodRaw = unquoteLiteral(methodNode.text);
      const path = unquoteLiteral(pathNode.text);
      if (methodRaw === null || path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'python-requests',
        method: methodRaw.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // Consumers: httpx.AsyncClient.<verb>("url")
    for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_VERB_PATTERNS, tree)) {
      const clientNode = match.captures.client;
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!clientNode || !methodNode || !pathNode) continue;
      if (!hasTrackedHttpxAsyncClient(httpxAsyncClients, clientNode)) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'python-httpx',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // Consumers: httpx.AsyncClient.request("METHOD", "url")
    for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_GENERIC_PATTERNS, tree)) {
      const clientNode = match.captures.client;
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!clientNode || !methodNode || !pathNode) continue;
      if (!hasTrackedHttpxAsyncClient(httpxAsyncClients, clientNode)) continue;
      const methodRaw = unquoteLiteral(methodNode.text);
      const path = unquoteLiteral(pathNode.text);
      if (methodRaw === null || path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'python-httpx',
        method: methodRaw.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // Consumers: wrapper classes with uri= or url= keyword argument
    //   obj.fetch(uri="api/v1/camera/info/")
    //   obj.post(url="api/v1/config/update/")
    const seenUriDetections = new Set<string>(); // node byte ranges, to avoid duplicates
    for (const match of runCompiledPatterns(WRAPPER_URI_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;

      // Deduplicate: the two pattern branches can match the same call. Key on
      // node byte offsets, not line arithmetic (lineNum*1000+row can collide in
      // files over 1000 lines, and miss a real dup when a node straddles a line).
      const dedupKey = `${pathNode.startIndex}:${methodNode.startIndex}`;
      if (seenUriDetections.has(dedupKey)) continue;
      seenUriDetections.add(dedupKey);

      const methodName = methodNode.text.toLowerCase();
      // Map wrapper method name to HTTP verb (fetch, request → GET)
      const httpMethod = WRAPPER_METHOD_TO_HTTP[methodName] ?? 'GET';

      out.push({
        role: 'consumer',
        framework: 'python-http-wrapper',
        method: httpMethod,
        path,
        name: null,
        line: methodNode.startPosition.row + 1,
        confidence: 0.65,
      });
    }

    // Variable propagation: uri = "api/v1/endpoint/"; obj.fetch(uri=uri)
    // Many repos assign URL paths to local vars then pass as keyword args.
    const localStrings = buildLocalStringMap(tree);
    const seenVarDetections = new Set<string>();
    for (const match of runCompiledPatterns(WRAPPER_URI_VAR_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathVarNode = match.captures.path_var;
      if (!methodNode || !pathVarNode) continue;
      const dedupKey = `${pathVarNode.startPosition.row}:${methodNode.startPosition.row}`;
      if (seenVarDetections.has(dedupKey)) continue;
      seenVarDetections.add(dedupKey);
      const resolved = localStrings.get(pathVarNode.text);
      if (!resolved) continue;
      const normalized = normalizeConsumerPath(resolved);
      if (normalized === '/') continue;
      const httpMethod = WRAPPER_METHOD_TO_HTTP[methodNode.text.toLowerCase()] ?? 'GET';
      out.push({
        role: 'consumer',
        framework: 'python-http-wrapper',
        method: httpMethod,
        path: normalized,
        name: null,
        line: methodNode.startPosition.row + 1,
        confidence: 0.6,
      });
    }

    return out;
  },
};

/** Normalize consumer path: strip host, template literals, numeric segments → {param} */
function normalizeConsumerPath(url: string): string {
  let s = url.replace(/\$\{[^}]+\}/g, '{param}').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      s = s.replace(/^https?:\/\/[^/]+/i, '');
    }
  }
  if (!s.startsWith('/')) s = '/' + s;
  const segments = s
    .split('/')
    .filter(Boolean)
    .map((seg) => (/^\d+$/.test(seg) ? '{param}' : seg));
  s = '/' + segments.join('/');
  return s.replace(/\/+$/, '') || '/';
}
