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
 *   - Spring `RestTemplate.getForObject/...`, `exchange(...)`
 *   - Spring `WebClient.get().uri(...)`, `WebClient.method(HttpMethod.X).uri(...)`
 *   - OkHttp `new Request.Builder().url("...")`
 *   - OpenFeign interfaces with Spring MVC method annotations
 *   - Java / Apache HttpClient literal request construction
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
// Two patterns are needed because the AST shape differs depending on
// whether the annotation uses a positional argument or a named one:
//   @RequestMapping("/api")          → (annotation_argument_list (string_literal))
//   @RequestMapping(path = "/api")   → (annotation_argument_list (element_value_pair key:(identifier) value:(string_literal)))
//   @RequestMapping(value = "/api")  → same as above
//
// The named-argument pattern MUST constrain the `key` field to the route
// member names (`path`/`value`); without it, the query also captures
// non-route attributes such as `produces`, `consumes`, `headers`, `name`,
// `params` (their right-hand string literals would be mis-extracted as
// route prefixes — e.g. `produces = "application/json"` would corrupt
// every method route under that controller). The sibling
// `topic-patterns/java.ts` uses the same `key:` constraint approach.
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
              name: (_) @ann (#match? @ann "(^|\\\\.)RequestMapping$")
              arguments: (annotation_argument_list (string_literal) @prefix)))) @class
      `,
    },
    {
      meta: {},
      query: `
        (class_declaration
          (modifiers
            (annotation
              name: (_) @ann (#match? @ann "(^|\\\\.)RequestMapping$")
              arguments: (annotation_argument_list
                (element_value_pair
                  key: (identifier) @key (#match? @key "^(path|value)$")
                  value: (string_literal) @prefix))))) @class
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const SPRING_INTERFACE_PREFIX_PATTERNS = compilePatterns({
  name: 'java-spring-interface-prefix',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (interface_declaration
          (modifiers
            (annotation
              name: (_) @ann (#match? @ann "(^|\\\\.)RequestMapping$")
              arguments: (annotation_argument_list (string_literal) @prefix)))) @interface
      `,
    },
    {
      meta: {},
      query: `
        (interface_declaration
          (modifiers
            (annotation
              name: (_) @ann (#match? @ann "(^|\\\\.)RequestMapping$")
              arguments: (annotation_argument_list
                (element_value_pair
                  key: (identifier) @key (#match? @key "^(path|value)$")
                  value: (string_literal) @prefix))))) @interface
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: OpenFeign interface-level prefixes ───────────────────
// Feign's `name`/`value` attributes identify a service, not an HTTP path,
// so only `path` is used as a URL prefix. `@RequestMapping` on a Feign
// interface is also common and does carry a path prefix.
const FEIGN_INTERFACE_PREFIX_PATTERNS = compilePatterns({
  name: 'java-feign-interface-prefix',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (interface_declaration
          (modifiers
            (annotation
              name: (_) @ann (#match? @ann "(^|\\\\.)FeignClient$")
              arguments: (annotation_argument_list
                (element_value_pair
                  key: (identifier) @key (#eq? @key "path")
                  value: (string_literal) @prefix))))) @interface
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Provider: Spring @(Get|Post|...)Mapping method annotations ───────
// Same dual-pattern approach: positional vs named argument. The named
// pattern restricts the annotation member name to `path`/`value` to
// avoid capturing unrelated string-valued attributes
// (`produces`, `consumes`, `headers`, `name`, `params`, ...).
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
              name: (_) @ann (#match? @ann "(^|\\\\.)(Get|Post|Put|Delete|Patch)Mapping$")
              arguments: (annotation_argument_list (string_literal) @path)))
          name: (identifier) @method_name) @method
      `,
    },
    {
      meta: {},
      query: `
        (method_declaration
          (modifiers
            (annotation
              name: (_) @ann (#match? @ann "(^|\\\\.)(Get|Post|Put|Delete|Patch)Mapping$")
              arguments: (annotation_argument_list
                (element_value_pair
                  key: (identifier) @key (#match? @key "^(path|value)$")
                  value: (string_literal) @path))))
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
// Source-scan only: receiver must be named exactly `restTemplate`.
// Fields, `this.restTemplate`, aliases, and other injection names are deferred.
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
          arguments: (argument_list . (_) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<RestTemplateMeta>);

const REST_TEMPLATE_EXCHANGE_PATTERNS = compilePatterns({
  name: 'java-rest-template-exchange',
  language: Java,
  patterns: [
    {
      meta: { framework: 'spring-rest-template' },
      query: `
        (method_invocation
          object: (identifier) @obj (#eq? @obj "restTemplate")
          name: (identifier) @method (#eq? @method "exchange")
          arguments: (argument_list
            . (_) @path
            (field_access
              object: (identifier) @httpMethodCls (#eq? @httpMethodCls "HttpMethod")
              field: (identifier) @http_method)))
      `,
    },
  ],
} satisfies LanguagePatterns<RestTemplateMeta>);

const WEB_CLIENT_SHORT_TO_HTTP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

const WEB_CLIENT_LONG_METHODS = new Set(Object.values(WEB_CLIENT_SHORT_TO_HTTP));

const WEB_CLIENT_SHORT_FORM_PATTERNS = compilePatterns({
  name: 'java-web-client-short-form',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (identifier) @obj (#eq? @obj "webClient")
            name: (identifier) @verb (#match? @verb "^(get|post|put|delete|patch)$")
            arguments: (argument_list))
          name: (identifier) @uri_method (#eq? @uri_method "uri")
          arguments: (argument_list . (string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const WEB_CLIENT_LONG_FORM_PATTERNS = compilePatterns({
  name: 'java-web-client-long-form',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (method_invocation
              object: (identifier) @obj (#eq? @obj "webClient")
              name: (identifier) @method (#eq? @method "method")
              arguments: (argument_list
                (field_access
                  object: (identifier) @httpMethodCls (#eq? @httpMethodCls "HttpMethod")
                  field: (identifier) @http_method)))
            name: (identifier) @uri_method (#eq? @uri_method "uri")
            arguments: (argument_list . (string_literal) @path)))
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
          arguments: (argument_list . (string_literal) @path)) @call
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const JAVA_HTTP_CLIENT_PATTERNS = compilePatterns({
  name: 'java-http-client',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (method_invocation
              object: (identifier) @builderCls (#eq? @builderCls "HttpRequest")
              name: (identifier) @newBuilder (#eq? @newBuilder "newBuilder")
              arguments: (argument_list))
            name: (identifier) @uri_method (#eq? @uri_method "uri")
            arguments: (argument_list
              (method_invocation
                object: (identifier) @uriCls (#eq? @uriCls "URI")
                name: (identifier) @create (#eq? @create "create")
                arguments: (argument_list . (string_literal) @path))))
          name: (identifier) @http_method (#match? @http_method "^(GET|POST|PUT|DELETE|HEAD)$"))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const JAVA_HTTP_CLIENT_METHOD_PATTERNS = compilePatterns({
  name: 'java-http-client-method',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (method_invocation
              object: (identifier) @builderCls (#eq? @builderCls "HttpRequest")
              name: (identifier) @newBuilder (#eq? @newBuilder "newBuilder")
              arguments: (argument_list))
            name: (identifier) @uri_method (#eq? @uri_method "uri")
            arguments: (argument_list
              (method_invocation
                object: (identifier) @uriCls (#eq? @uriCls "URI")
                name: (identifier) @create (#eq? @create "create")
                arguments: (argument_list . (string_literal) @path))))
          name: (identifier) @method (#eq? @method "method")
          arguments: (argument_list . (string_literal) @http_method))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const JAVA_HTTP_CLIENT_DEFAULT_GET_PATTERNS = compilePatterns({
  name: 'java-http-client-default-get',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (method_invocation
              object: (identifier) @builderCls (#eq? @builderCls "HttpRequest")
              name: (identifier) @newBuilder (#eq? @newBuilder "newBuilder")
              arguments: (argument_list))
            name: (identifier) @uri_method (#eq? @uri_method "uri")
            arguments: (argument_list
              (method_invocation
                object: (identifier) @uriCls (#eq? @uriCls "URI")
                name: (identifier) @create (#eq? @create "create")
                arguments: (argument_list . (string_literal) @path))))
          name: (identifier) @build (#eq? @build "build")
          arguments: (argument_list))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const APACHE_HTTP_CLIENT_TO_HTTP: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpDelete: 'DELETE',
  HttpPatch: 'PATCH',
};

const APACHE_HTTP_CLIENT_PATTERNS = compilePatterns({
  name: 'java-apache-http-client',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (object_creation_expression
          type: (type_identifier) @type (#match? @type "^Http(Get|Post|Put|Delete|Patch)$")
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

function findEnclosingInterface(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'interface_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

function hasAnnotation(node: Parser.SyntaxNode, annotationName: string): boolean {
  for (const child of node.namedChildren) {
    if (child.type !== 'modifiers') continue;
    for (const modifier of child.namedChildren) {
      if (modifier.type !== 'annotation') continue;
      const nameNode = modifier.childForFieldName('name');
      if (!nameNode) continue;
      const simpleName = nameNode.text.split('.').pop();
      if (nameNode.text === annotationName || simpleName === annotationName) return true;
    }
  }
  return false;
}

function simpleName(text: string): string {
  return text.split('.').pop() ?? text;
}

function methodInvocationName(node: Parser.SyntaxNode): string | null {
  return node.type === 'method_invocation' ? (node.childForFieldName('name')?.text ?? null) : null;
}

function methodInvocationObject(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.type === 'method_invocation' ? node.childForFieldName('object') : null;
}

function methodInvocationArguments(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const argsNode = node.type === 'method_invocation' ? node.childForFieldName('arguments') : null;
  return argsNode?.namedChildren ?? [];
}

function firstLiteralArgument(node: Parser.SyntaxNode): string | null {
  const first = methodInvocationArguments(node)[0];
  return first?.type === 'string_literal' ? unquoteLiteral(first.text) : null;
}

function appendPath(base: string, subPath: string): string {
  if (!base) return subPath.startsWith('/') ? subPath : `/${subPath}`;
  if (!subPath) return base;
  return `${base.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}`;
}

function extractUriCreatePath(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'method_invocation') return null;
  const objectNode = methodInvocationObject(node);
  if (objectNode?.text !== 'URI' || methodInvocationName(node) !== 'create') return null;
  return firstLiteralArgument(node);
}

function extractUriComponentsBuilderPath(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'method_invocation') return null;
  const name = methodInvocationName(node);
  const objectNode = methodInvocationObject(node);
  if (
    (name === 'fromPath' || name === 'fromUriString' || name === 'fromHttpUrl') &&
    objectNode?.text === 'UriComponentsBuilder'
  )
    return firstLiteralArgument(node);
  if (!objectNode) return null;
  if (name === 'path') {
    const base = extractUriComponentsBuilderPath(objectNode);
    const subPath = firstLiteralArgument(node);
    return base !== null && subPath !== null ? appendPath(base, subPath) : null;
  }
  if (name === 'pathSegment') {
    const base = extractUriComponentsBuilderPath(objectNode);
    if (base === null) return null;
    const segments = methodInvocationArguments(node)
      .map((arg) => (arg.type === 'string_literal' ? unquoteLiteral(arg.text) : null))
      .filter((segment): segment is string => segment !== null);
    if (segments.length !== methodInvocationArguments(node).length) return null;
    return segments.reduce((acc, segment) => appendPath(acc, segment), base);
  }
  if (
    name === 'build' ||
    name === 'toUriString' ||
    name === 'toUri' ||
    name === 'encode' ||
    name === 'query' ||
    name === 'queryParam' ||
    name === 'queryParams' ||
    name === 'replaceQuery' ||
    name === 'replaceQueryParam' ||
    name === 'replaceQueryParams'
  )
    return extractUriComponentsBuilderPath(objectNode);
  return null;
}

function extractStaticPathExpression(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string_literal') return unquoteLiteral(node.text);
  return extractUriCreatePath(node) ?? extractUriComponentsBuilderPath(node);
}

function inferOkHttpMethod(urlCall: Parser.SyntaxNode): string {
  let cur: Parser.SyntaxNode = urlCall;
  let parent = cur.parent;
  while (parent?.type === 'method_invocation' && methodInvocationObject(parent)?.id === cur.id) {
    const name = methodInvocationName(parent);
    if (name && ['get', 'head', 'post', 'put', 'delete', 'patch'].includes(name))
      return name.toUpperCase();
    if (name === 'method') {
      const method = firstLiteralArgument(parent);
      return method?.toUpperCase() ?? 'GET';
    }
    cur = parent;
    parent = parent.parent;
  }
  return 'GET';
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

    const feignPrefixByInterfaceId = new Map<number, string>();
    const prefixByInterfaceId = new Map<number, string>();
    for (const match of runCompiledPatterns(SPRING_INTERFACE_PREFIX_PATTERNS, tree)) {
      const prefixNode = match.captures.prefix;
      const interfaceNode = match.captures.interface;
      if (!prefixNode || !interfaceNode) continue;
      const prefix = unquoteLiteral(prefixNode.text);
      if (prefix !== null) prefixByInterfaceId.set(interfaceNode.id, prefix);
    }

    for (const match of runCompiledPatterns(FEIGN_INTERFACE_PREFIX_PATTERNS, tree)) {
      const prefixNode = match.captures.prefix;
      const interfaceNode = match.captures.interface;
      if (!prefixNode || !interfaceNode) continue;
      const prefix = unquoteLiteral(prefixNode.text);
      if (prefix !== null) feignPrefixByInterfaceId.set(interfaceNode.id, prefix);
    }

    for (const match of runCompiledPatterns(SPRING_METHOD_ROUTE_PATTERNS, tree)) {
      const annNode = match.captures.ann;
      const pathNode = match.captures.path;
      const nameNode = match.captures.method_name;
      const methodNode = match.captures.method;
      if (!annNode || !pathNode || !methodNode) continue;
      const httpMethod = METHOD_ANNOTATION_TO_HTTP[simpleName(annNode.text)];
      if (!httpMethod) continue;
      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;
      const enclosingInterface = findEnclosingInterface(methodNode);
      if (enclosingInterface && hasAnnotation(enclosingInterface, 'FeignClient')) {
        const prefix =
          feignPrefixByInterfaceId.get(enclosingInterface.id) ??
          prefixByInterfaceId.get(enclosingInterface.id) ??
          '';
        const fullPath = joinPath(prefix, rawPath);
        out.push({
          role: 'consumer',
          framework: 'openfeign',
          method: httpMethod,
          path: fullPath,
          name: nameNode?.text ?? null,
          confidence: 0.7,
        });
        continue;
      }
      if (enclosingInterface) {
        const prefix = prefixByInterfaceId.get(enclosingInterface.id) ?? '';
        const fullPath = joinPath(prefix, rawPath);
        out.push({
          role: 'provider',
          framework: 'spring',
          method: httpMethod,
          path: fullPath,
          name: nameNode?.text ?? null,
          confidence: 0.8,
        });
        continue;
      }
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
      const path = extractStaticPathExpression(pathNode);
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

    for (const match of runCompiledPatterns(REST_TEMPLATE_EXCHANGE_PATTERNS, tree)) {
      const httpMethodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!httpMethodNode || !pathNode) continue;
      const path = extractStaticPathExpression(pathNode);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'spring-rest-template',
        method: httpMethodNode.text.toUpperCase(),
        path,
        name: null,
        confidence: 0.7,
      });
    }

    // ─── Consumers: WebClient.get().uri("path") short form ─────────
    // Source-scan only: receiver must be named exactly `webClient`.
    for (const match of runCompiledPatterns(WEB_CLIENT_SHORT_FORM_PATTERNS, tree)) {
      const verbNode = match.captures.verb;
      const pathNode = match.captures.path;
      if (!verbNode || !pathNode) continue;
      const httpMethod = WEB_CLIENT_SHORT_TO_HTTP[verbNode.text];
      if (!httpMethod) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'spring-web-client',
        method: httpMethod,
        path,
        name: null,
        confidence: 0.7,
      });
    }

    for (const match of runCompiledPatterns(WEB_CLIENT_LONG_FORM_PATTERNS, tree)) {
      const httpMethodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!httpMethodNode || !pathNode) continue;
      const httpMethod = httpMethodNode.text.toUpperCase();
      if (!WEB_CLIENT_LONG_METHODS.has(httpMethod)) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'spring-web-client',
        method: httpMethod,
        path,
        name: null,
        confidence: 0.7,
      });
    }

    // ─── Consumers: OkHttp Request.Builder().url("path") ────────────
    for (const match of runCompiledPatterns(OK_HTTP_PATTERNS, tree)) {
      const callNode = match.captures.call;
      const pathNode = match.captures.path;
      if (!callNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'okhttp',
        method: inferOkHttpMethod(callNode),
        path,
        name: null,
        confidence: 0.7,
      });
    }

    // ─── Consumers: Java HttpClient request builder ─────────────────
    // Java's standard builder exposes GET/POST/PUT/DELETE/HEAD helpers.
    // Other verbs, including PATCH, use `.method("PATCH", body)`.
    for (const match of runCompiledPatterns(JAVA_HTTP_CLIENT_PATTERNS, tree)) {
      const httpMethodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!httpMethodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'java-http-client',
        method: httpMethodNode.text.toUpperCase(),
        path,
        name: null,
        confidence: 0.65,
      });
    }

    for (const match of runCompiledPatterns(JAVA_HTTP_CLIENT_METHOD_PATTERNS, tree)) {
      const httpMethodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!httpMethodNode || !pathNode) continue;
      const httpMethod = unquoteLiteral(httpMethodNode.text);
      const path = unquoteLiteral(pathNode.text);
      if (httpMethod === null || path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'java-http-client',
        method: httpMethod.toUpperCase(),
        path,
        name: null,
        confidence: 0.65,
      });
    }

    for (const match of runCompiledPatterns(JAVA_HTTP_CLIENT_DEFAULT_GET_PATTERNS, tree)) {
      const pathNode = match.captures.path;
      if (!pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'java-http-client',
        method: 'GET',
        path,
        name: null,
        confidence: 0.65,
      });
    }

    // ─── Consumers: Apache HttpClient request constructors ──────────
    for (const match of runCompiledPatterns(APACHE_HTTP_CLIENT_PATTERNS, tree)) {
      const typeNode = match.captures.type;
      const pathNode = match.captures.path;
      if (!typeNode || !pathNode) continue;
      const httpMethod = APACHE_HTTP_CLIENT_TO_HTTP[typeNode.text];
      if (!httpMethod) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'apache-http-client',
        method: httpMethod,
        path,
        name: null,
        confidence: 0.65,
      });
    }

    return out;
  },
};
