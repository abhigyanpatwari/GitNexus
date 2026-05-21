import type Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

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

// ─── Provider: FastAPI @app.get/... ──────────────────────────────────
const FASTAPI_PATTERNS = compilePatterns({
  name: 'python-fastapi',
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

export const PYTHON_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'python-http',
  language: Python,
  scan(tree) {
    const out: HttpDetection[] = [];
    const httpxAsyncClients = collectHttpxAsyncClients(tree);

    // Providers: FastAPI
    for (const match of runCompiledPatterns(FASTAPI_PATTERNS, tree)) {
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
