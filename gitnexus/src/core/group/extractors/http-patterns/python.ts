import type Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin, RepoContext } from './types.js';

/**
 * Python HTTP plugin. Handles:
 *   - FastAPI `@app.get("/path")` provider decorators
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

// ─── Consumer: requests.get/post/... ──────────────────────────────────
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
}

/** Strip `.py` and return the bare basename (e.g. `api/users.py` → `users`). */
function fileShortKey(rel: string): string {
  const slash = rel.lastIndexOf('/');
  const file = slash >= 0 ? rel.slice(slash + 1) : rel;
  return file.endsWith('.py') ? file.slice(0, -3) : file;
}

/**
 * Long key for a `.py` file: parent directory + stem, joined with `/`.
 * Files at the repo root return the empty string (no parent), in which
 * case callers should fall back to the short key.
 */
function fileLongKey(rel: string): string {
  const noExt = rel.endsWith('.py') ? rel.slice(0, -3) : rel;
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

function buildPythonRepoContext(
  files: string[],
  parser: Parser,
  readFile: (rel: string) => string | null,
  parseSource: (parser: Parser, src: string) => Parser.Tree | null,
): PythonRepoContext {
  const prefixesByLongKey = new Map<string, Set<string>>();
  const prefixesByShortKey = new Map<string, Set<string>>();

  // Pre-pass over .py files. We deliberately run this even on files
  // that don't contain `include_router` — the cost of an extra parse
  // is bounded by the file count, and detecting `include_router`
  // beforehand would require its own grep/scan.
  for (const rel of files) {
    if (!rel.endsWith('.py')) continue;
    const src = readFile(rel);
    if (!src) continue;
    if (!src.includes('include_router')) continue;
    parser.setLanguage(Python);
    const tree = parseSource(parser, src);
    if (!tree) continue;

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

  return { prefixesByLongKey, prefixesByShortKey };
}

function joinPrefix(prefix: string, route: string): string {
  // Mirror FastAPI's path joining: trim trailing slash off prefix,
  // ensure exactly one leading slash on the result.
  const p = prefix.replace(/\/+$/, '');
  const r = route.startsWith('/') ? route : `/${route}`;
  return `${p}${r}`;
}
export const PYTHON_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'python-http',
  language: Python,
  prepareRepo({ files, parser, readFile, parseSource }): RepoContext {
    return buildPythonRepoContext(files, parser, readFile, parseSource);
  },
  scan(tree, repoContext, fileRel) {
    const out: HttpDetection[] = [];
    const httpxAsyncClients = collectHttpxAsyncClients(tree);
    const ctx = repoContext as PythonRepoContext | undefined;

    // Providers: FastAPI @app.<verb>("/path") — already absolute path.
    for (const match of runCompiledPatterns(FASTAPI_APP_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const httpMethod = FASTAPI_VERBS[methodNode.text];
      if (!httpMethod) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'provider',
        framework: 'fastapi',
        method: httpMethod,
        path,
        name: null,
        confidence: 0.8,
      });
    }

    // Providers: FastAPI @router.<verb>("/path") — must be joined
    // with the prefix(es) declared at the include_router site. When
    // no prefix is found we still emit the unprefixed path so this
    // change is strictly additive vs. the prior @app-only behaviour;
    // when the same router is mounted under multiple prefixes we emit
    // one detection per prefix.
    for (const match of runCompiledPatterns(FASTAPI_ROUTER_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const httpMethod = FASTAPI_VERBS[methodNode.text];
      if (!httpMethod) continue;
      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;

      // Long key first (precise, package-aware), short key as fallback.
      // Mirrors the ingestion-side resolution in parse-impl.ts so the
      // graph nodes and group contracts agree on which prefix applies.
      const longKey = fileRel ? fileLongKey(fileRel) : '';
      const longPrefixes = longKey ? ctx?.prefixesByLongKey.get(longKey) : undefined;
      const shortKey = fileRel ? fileShortKey(fileRel) : '';
      const shortPrefixes =
        longPrefixes || !shortKey ? undefined : ctx?.prefixesByShortKey.get(shortKey);
      const prefixSet = longPrefixes ?? shortPrefixes;
      const paths =
        prefixSet && prefixSet.size > 0
          ? [...prefixSet].map((p) => joinPrefix(p, rawPath))
          : [rawPath];

      for (const p of paths) {
        out.push({
          role: 'provider',
          framework: 'fastapi',
          method: httpMethod,
          path: p,
          name: null,
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
        confidence: 0.7,
      });
    }

    return out;
  },
};
