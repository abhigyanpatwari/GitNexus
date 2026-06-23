import Go from 'tree-sitter-go';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Go HTTP plugin. Handles:
 *   - gin / echo / chi framework routing — `r.GET("/path", handler)`
 *   - net/http stdlib — `http.HandleFunc("/path", handler)`
 *   - net/http consumer — `http.Get(...)`, `http.NewRequest("METHOD", ...)`
 *   - resty consumer — `client.R().Delete("/path")`
 */

// ─── Provider: framework routing ──────────────────────────────────────
// Matches `\w+\.GET(...)` etc. (gin, echo, chi all share this shape).
// Captures the HTTP method (field name), path literal, and the handler —
// anchored to the LAST argument (`@handler .`) so a variadic middleware
// chain (`r.GET("/x", mw, handler)`, gin/echo/chi style) binds the real
// handler, not a middleware identifier (which would otherwise over-match
// and attach the route to the wrong symbol — see #2276 review).
const FRAMEWORK_ROUTE_PATTERNS = compilePatterns({
  name: 'go-framework-route',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            field: (field_identifier) @http_method (#match? @http_method "^(GET|POST|PUT|DELETE|PATCH)$"))
          arguments: (argument_list
            (interpreted_string_literal) @path
            [(identifier) (func_literal)] @handler
            .))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Provider: net/http `http.HandleFunc("/p", handler)` ─────────────
const HANDLE_FUNC_PATTERNS = compilePatterns({
  name: 'go-handle-func',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @pkg (#eq? @pkg "http")
            field: (field_identifier) @fn (#eq? @fn "HandleFunc"))
          arguments: (argument_list
            (interpreted_string_literal) @path
            [(identifier) (func_literal)] @handler
            .))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: net/http stdlib Get / Post / Head ─────────────────────
const HTTP_CLIENT_METHOD_TO_HTTP: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Head: 'GET', // HEAD has no body semantics we care about — treat as GET for contract matching
};

const HTTP_CLIENT_PATTERNS = compilePatterns({
  name: 'go-http-client',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @pkg (#eq? @pkg "http")
            field: (field_identifier) @fn (#match? @fn "^(Get|Post|Head)$"))
          arguments: (argument_list . (interpreted_string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: net/http `http.NewRequest("METHOD", "/path", ...)` ────
const NEW_REQUEST_PATTERNS = compilePatterns({
  name: 'go-new-request',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (identifier) @pkg (#eq? @pkg "http")
            field: (field_identifier) @fn (#eq? @fn "NewRequest"))
          arguments: (argument_list
            .
            (interpreted_string_literal) @http_method
            (interpreted_string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: resty `client.R().Delete("/path")` ─────────────────────
// Matches any chained call whose receiver is `something.R()` and whose
// method name is an HTTP verb. This is how go-resty's fluent API looks.
const RESTY_PATTERNS = compilePatterns({
  name: 'go-resty',
  language: Go,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          function: (selector_expression
            operand: (call_expression
              function: (selector_expression
                field: (field_identifier) @r (#eq? @r "R")))
            field: (field_identifier) @http_method (#match? @http_method "^(Get|Post|Put|Delete|Patch)$"))
          arguments: (argument_list . (interpreted_string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

export const GO_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'go-http',
  language: Go,
  scan(tree) {
    const out: HttpDetection[] = [];

    // Framework providers: r.GET/POST/... with handler identifier
    for (const match of runCompiledPatterns(FRAMEWORK_ROUTE_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      const handlerNode = match.captures.handler;
      if (!methodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      // An inline `func(){…}` handler has no name → emit `name: null` and a
      // `line` so it resolves to its containing/closure symbol by line-span
      // containment (like a consumer). A named identifier handler keeps its
      // name and resolves by name; `line` is harmless there.
      const isInlineHandler = handlerNode?.type === 'func_literal';
      out.push({
        role: 'provider',
        framework: 'go-framework',
        method: methodNode.text.toUpperCase(),
        path,
        name: isInlineHandler ? null : (handlerNode?.text ?? null),
        line: (handlerNode ?? pathNode).startPosition.row + 1,
        confidence: 0.8,
      });
    }

    // net/http HandleFunc: default method GET
    for (const match of runCompiledPatterns(HANDLE_FUNC_PATTERNS, tree)) {
      const pathNode = match.captures.path;
      const handlerNode = match.captures.handler;
      if (!pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      // Inline `func(){…}` handler → resolve by containment (see go-framework
      // note above); a named handler resolves by name.
      const isInlineHandler = handlerNode?.type === 'func_literal';
      out.push({
        role: 'provider',
        framework: 'go-stdlib',
        method: 'GET',
        path,
        name: isInlineHandler ? null : (handlerNode?.text ?? null),
        line: (handlerNode ?? pathNode).startPosition.row + 1,
        confidence: 0.8,
      });
    }

    // net/http client: http.Get/Post/Head
    for (const match of runCompiledPatterns(HTTP_CLIENT_PATTERNS, tree)) {
      const fnNode = match.captures.fn;
      const pathNode = match.captures.path;
      if (!fnNode || !pathNode) continue;
      const httpMethod = HTTP_CLIENT_METHOD_TO_HTTP[fnNode.text];
      if (!httpMethod) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'go-stdlib',
        method: httpMethod,
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // net/http NewRequest
    for (const match of runCompiledPatterns(NEW_REQUEST_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const method = unquoteLiteral(methodNode.text);
      const path = unquoteLiteral(pathNode.text);
      if (method === null || path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'go-stdlib',
        method: method.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // resty
    for (const match of runCompiledPatterns(RESTY_PATTERNS, tree)) {
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'go-resty',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    return out;
  },
};
