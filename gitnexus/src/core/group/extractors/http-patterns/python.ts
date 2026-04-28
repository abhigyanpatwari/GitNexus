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

export const PYTHON_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'python-http',
  language: Python,
  scan(tree) {
    const out: HttpDetection[] = [];

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

    return out;
  },
};
