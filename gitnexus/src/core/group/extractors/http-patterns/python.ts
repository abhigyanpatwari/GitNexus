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
 *   - `httpx.AsyncClient` instances calling `.get/.post/...("url")`
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
// NOTE: This targeted detector only tracks explicit `httpx.AsyncClient(...)`
// construction. Direct imports (`from httpx import AsyncClient`) and module
// aliases (`import httpx as hx`) and annotated assignments (`client: httpx.AsyncClient = ...`)
// are intentionally left for a follow-up. Module-scope clients are only matched
// at module scope; calls inside functions require a function/class-local tracked
// client to avoid false positives from same-name local variables.
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
              object: (identifier) @module (#eq? @module "httpx")
              attribute: (identifier) @client_class (#eq? @client_class "AsyncClient"))))
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
              object: (identifier) @module (#eq? @module "httpx")
              attribute: (identifier) @client_class (#eq? @client_class "AsyncClient")))
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
  const keys = new Set<string>();
  const preferClass = clientNode.text.includes('.');
  const nearestScope = getScopeKey(clientNode.parent, preferClass);

  keys.add(nearestScope);

  return [...keys];
}

function collectHttpxAsyncClients(tree: Parser.Tree): Map<string, Set<string>> {
  const clients = new Map<string, Set<string>>();

  const addClient = (clientNode: Parser.SyntaxNode | undefined) => {
    if (!clientNode) return;
    const scopeKey = trackedClientScopeKey(clientNode);
    const clientText = clientNode.text;
    const scopes = clients.get(clientText) ?? new Set<string>();
    scopes.add(scopeKey);
    clients.set(clientText, scopes);
  };

  for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_ASSIGN_PATTERNS, tree)) {
    addClient(match.captures.client);
  }

  for (const match of runCompiledPatterns(HTTPX_ASYNC_CLIENT_WITH_ALIAS_PATTERNS, tree)) {
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
