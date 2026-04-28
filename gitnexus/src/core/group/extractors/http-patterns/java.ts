import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Java HTTP plugin. Handles:
 *   - Spring `@RequestMapping` class prefixes + `@(Get|Post|...)Mapping` method annotations
 *   - Spring `RestTemplate.getForObject/...`, `WebClient.method(HttpMethod.X, ...)`
 *   - OkHttp `new Request.Builder().url("...")`
 *
 * The plugin runs two pattern bundles: one to collect class-level
 * `@RequestMapping` prefixes keyed by the enclosing class node, and a
 * second to match method-level annotations. The `scan` function walks
 * up from each matched annotation to find its enclosing class and
 * combines the prefix with the method path.
 */

const METHOD_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

// ─── Provider: Spring class-level @RequestMapping prefix ──────────────
const SPRING_CLASS_PREFIX_PATTERNS = compilePatterns({
  name: 'java-spring-class-prefix',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (class_declaration
          (modifiers
            (annotation
              name: (identifier) @ann (#eq? @ann "RequestMapping")
              arguments: (annotation_argument_list (string_literal) @prefix)))) @class
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Provider: Spring @(Get|Post|...)Mapping method annotations ───────
const SPRING_METHOD_ROUTE_PATTERNS = compilePatterns({
  name: 'java-spring-method-route',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_declaration
          (modifiers
            (annotation
              name: (identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$")
              arguments: (annotation_argument_list (string_literal) @path)))
          name: (identifier) @method_name) @method
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: Spring RestTemplate (object-named + method-named) ──────
// RestTemplate.getForObject / getForEntity → GET
// RestTemplate.postForObject / postForEntity → POST
// RestTemplate.put → PUT
// RestTemplate.delete → DELETE
// RestTemplate.patchForObject → PATCH
const REST_TEMPLATE_TO_HTTP: Record<string, string> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  postForObject: 'POST',
  postForEntity: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patchForObject: 'PATCH',
};

interface RestTemplateMeta {
  framework: 'spring-rest-template';
}

const REST_TEMPLATE_PATTERNS = compilePatterns({
  name: 'java-rest-template',
  language: Java,
  patterns: [
    {
      meta: { framework: 'spring-rest-template' },
      query: `
        (method_invocation
          object: (identifier) @obj (#eq? @obj "restTemplate")
          name: (identifier) @method
          arguments: (argument_list . (string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<RestTemplateMeta>);

// ─── Consumer: Spring WebClient — webClient.method(HttpMethod.X, "path") ─
const WEB_CLIENT_PATTERNS = compilePatterns({
  name: 'java-web-client',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (identifier) @obj (#eq? @obj "webClient")
          name: (identifier) @method (#eq? @method "method")
          arguments: (argument_list
            (field_access
              object: (identifier) @httpMethodCls (#eq? @httpMethodCls "HttpMethod")
              field: (identifier) @http_method)
            (string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: OkHttp `new Request.Builder().url("path")` ─────────────
// Note: `Request.Builder` is a `scoped_type_identifier` whose text includes
// the dot, so `#eq?` against the literal string matches cleanly (no need
// to escape a regex dot).
const OK_HTTP_PATTERNS = compilePatterns({
  name: 'java-okhttp',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (object_creation_expression
            type: (scoped_type_identifier) @type (#eq? @type "Request.Builder"))
          name: (identifier) @method (#eq? @method "url")
          arguments: (argument_list . (string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

/**
 * Find the nearest enclosing class_declaration ancestor for a node, or
 * null if the node is top-level. Tree-sitter's SyntaxNode.parent walks
 * one level at a time.
 */
function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Join a class-level prefix and a method-level path into a single URL
 * path. Mirrors the semantics of the original regex implementation:
 * strip trailing slashes on the prefix, then ensure a single slash
 * between prefix and method path.
 */
function joinPath(prefix: string, methodPath: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanSub = methodPath.replace(/^\/+/, '');
  if (!cleanPrefix) return `/${cleanSub}`;
  return `/${cleanPrefix}/${cleanSub}`;
}

export const JAVA_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'java-http',
  language: Java,
  scan(tree) {
    const out: HttpDetection[] = [];

    // ─── Providers: Spring class prefix + method annotations ────────
    const prefixByClassId = new Map<number, string>();
    for (const match of runCompiledPatterns(SPRING_CLASS_PREFIX_PATTERNS, tree)) {
      const prefixNode = match.captures.prefix;
      const classNode = match.captures.class;
      if (!prefixNode || !classNode) continue;
      const prefix = unquoteLiteral(prefixNode.text);
      if (prefix !== null) prefixByClassId.set(classNode.id, prefix);
    }

    for (const match of runCompiledPatterns(SPRING_METHOD_ROUTE_PATTERNS, tree)) {
      const annNode = match.captures.ann;
      const pathNode = match.captures.path;
      const nameNode = match.captures.method_name;
      const methodNode = match.captures.method;
      if (!annNode || !pathNode || !methodNode) continue;
      const httpMethod = METHOD_ANNOTATION_TO_HTTP[annNode.text];
      if (!httpMethod) continue;
      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;
      const enclosingClass = findEnclosingClass(methodNode);
      const prefix = enclosingClass ? (prefixByClassId.get(enclosingClass.id) ?? '') : '';
      const fullPath = joinPath(prefix, rawPath);
      out.push({
        role: 'provider',
        framework: 'spring',
        method: httpMethod,
        path: fullPath,
        name: nameNode?.text ?? null,
        confidence: 0.8,
      });
    }

    // ─── Consumers: RestTemplate ────────────────────────────────────
    for (const match of runCompiledPatterns(REST_TEMPLATE_PATTERNS, tree)) {
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!methodNode || !pathNode) continue;
      const httpMethod = REST_TEMPLATE_TO_HTTP[methodNode.text];
      if (!httpMethod) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'spring-rest-template',
        method: httpMethod,
        path,
        name: null,
        confidence: 0.7,
      });
    }

    // ─── Consumers: WebClient.method(HttpMethod.X, "path") ──────────
    for (const match of runCompiledPatterns(WEB_CLIENT_PATTERNS, tree)) {
      const httpMethodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!httpMethodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'spring-web-client',
        method: httpMethodNode.text.toUpperCase(),
        path,
        name: null,
        confidence: 0.7,
      });
    }

    // ─── Consumers: OkHttp Request.Builder().url("path") ────────────
    for (const match of runCompiledPatterns(OK_HTTP_PATTERNS, tree)) {
      const pathNode = match.captures.path;
      if (!pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'okhttp',
        method: 'GET',
        path,
        name: null,
        confidence: 0.7,
      });
    }

    return out;
  },
};
