import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type {
  HttpDetection,
  HttpFileDetections,
  HttpLanguagePlugin,
  HttpScanInput,
} from './types.js';

/**
 * Java HTTP plugin. Handles:
 *   - Spring `@RequestMapping` class prefixes + `@(Get|Post|...)Mapping` method annotations
 *   - Spring `RestTemplate.getForObject/...`, `exchange(...)`
 *   - Spring `WebClient.method(HttpMethod.X, ...)`, `WebClient.get().uri(...)`
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
interface SpringRouteBinding {
  method: string;
  path: string;
}

interface SpringMethodInfo {
  name: string;
  routes: SpringRouteBinding[];
}

interface SpringTypeInfo {
  filePath: string;
  kind: 'class' | 'interface';
  name: string;
  classPrefix: string;
  implementedInterfaces: string[];
  isController: boolean;
  methods: SpringMethodInfo[];
}

// ─── Provider: Spring class/interface-level @RequestMapping prefix ───
const SPRING_TYPE_PREFIX_PATTERNS = compilePatterns({
  name: 'java-spring-type-prefix',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        [
          (class_declaration
            (modifiers
              (annotation
                name: (identifier) @ann (#eq? @ann "RequestMapping")
                arguments: (annotation_argument_list (string_literal) @prefix)))) @type
          (interface_declaration
            (modifiers
              (annotation
                name: (identifier) @ann (#eq? @ann "RequestMapping")
                arguments: (annotation_argument_list (string_literal) @prefix)))) @type
        ]
      `,
    },
    {
      meta: {},
      query: `
        [
          (class_declaration
            (modifiers
              (annotation
                name: (identifier) @ann (#eq? @ann "RequestMapping")
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key (#match? @key "^(path|value)$")
                    value: (string_literal) @prefix))))) @type
          (interface_declaration
            (modifiers
              (annotation
                name: (identifier) @ann (#eq? @ann "RequestMapping")
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key (#match? @key "^(path|value)$")
                    value: (string_literal) @prefix))))) @type
        ]
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

const SPRING_TYPE_DECLARATION_PATTERNS = compilePatterns({
  name: 'java-spring-type-declaration',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        [
          (class_declaration name: (identifier) @type_name) @type
          (interface_declaration name: (identifier) @type_name) @type
        ]
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
              name: (identifier) @ann (#eq? @ann "FeignClient")
              arguments: (annotation_argument_list
                (element_value_pair
                  key: (identifier) @key (#eq? @key "path")
                  value: (string_literal) @prefix))))) @interface
      `,
    },
    {
      meta: {},
      query: `
        (interface_declaration
          (modifiers
            (annotation
              name: (identifier) @ann (#eq? @ann "RequestMapping")
              arguments: (annotation_argument_list (string_literal) @prefix)))) @interface
      `,
    },
    {
      meta: {},
      query: `
        (interface_declaration
          (modifiers
            (annotation
              name: (identifier) @ann (#eq? @ann "RequestMapping")
              arguments: (annotation_argument_list
                (element_value_pair
                  key: (identifier) @key (#match? @key "^(path|value)$")
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
              name: (identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$")
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
              name: (identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$")
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
          arguments: (argument_list . (string_literal) @path))
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
            . (string_literal) @path
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
          name: (identifier) @http_method (#match? @http_method "^(GET|POST|PUT|DELETE)$"))
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
 * Find the nearest enclosing class/interface declaration ancestor for
 * a node, or null if the node is top-level. Tree-sitter's
 * SyntaxNode.parent walks one level at a time.
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

function getNodeName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

function hasAnnotation(node: Parser.SyntaxNode, names: string | readonly string[]): boolean {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  if (!modifiers) return false;
  const allowed = new Set(typeof names === 'string' ? [names] : names);
  const stack = [...modifiers.namedChildren];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const annotationName = cur.childForFieldName('name')?.text ?? '';
    const simpleName = annotationName.split('.').pop() ?? annotationName;
    if (
      (cur.type === 'annotation' || cur.type === 'marker_annotation') &&
      (allowed.has(annotationName) || allowed.has(simpleName))
    ) {
      return true;
    }
    stack.push(...cur.namedChildren);
  }
  return false;
}

function collectTypePrefixes(tree: Parser.Tree): Map<number, string> {
  const prefixByTypeId = new Map<number, string>();
  for (const match of runCompiledPatterns(SPRING_TYPE_PREFIX_PATTERNS, tree)) {
    const prefixNode = match.captures.prefix;
    const typeNode = match.captures.type;
    if (!prefixNode || !typeNode) continue;
    const prefix = unquoteLiteral(prefixNode.text);
    if (prefix !== null) prefixByTypeId.set(typeNode.id, prefix);
  }
  return prefixByTypeId;
}

function collectMethodRoutes(tree: Parser.Tree): Map<number, SpringRouteBinding[]> {
  const routesByMethodId = new Map<number, SpringRouteBinding[]>();
  for (const match of runCompiledPatterns(SPRING_METHOD_ROUTE_PATTERNS, tree)) {
    const annNode = match.captures.ann;
    const pathNode = match.captures.path;
    const methodNode = match.captures.method;
    if (!annNode || !pathNode || !methodNode) continue;
    const httpMethod = METHOD_ANNOTATION_TO_HTTP[annNode.text];
    if (!httpMethod) continue;
    const rawPath = unquoteLiteral(pathNode.text);
    if (rawPath === null) continue;
    const routes = routesByMethodId.get(methodNode.id) ?? [];
    routes.push({ method: httpMethod, path: rawPath });
    routesByMethodId.set(methodNode.id, routes);
  }
  return routesByMethodId;
}

function collectDirectMethods(typeNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'method_declaration') {
        out.push(child);
        continue;
      }
      if (
        child !== typeNode &&
        (child.type === 'class_declaration' || child.type === 'interface_declaration')
      ) {
        continue;
      }
      visit(child);
    }
  };
  visit(typeNode);
  return out;
}

function collectImplementedInterfaces(typeNode: Parser.SyntaxNode): string[] {
  const interfacesNode = typeNode.childForFieldName('interfaces');
  if (!interfacesNode) return [];
  const out: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'type_identifier' || node.type === 'scoped_type_identifier') {
      out.push(node.text.split('.').pop() ?? node.text);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(interfacesNode);
  return out;
}

function collectSpringTypes(filePath: string, tree: Parser.Tree): SpringTypeInfo[] {
  const prefixByTypeId = collectTypePrefixes(tree);
  const routesByMethodId = collectMethodRoutes(tree);
  const out: SpringTypeInfo[] = [];

  for (const match of runCompiledPatterns(SPRING_TYPE_DECLARATION_PATTERNS, tree)) {
    const typeNode = match.captures.type;
    const typeNameNode = match.captures.type_name;
    if (!typeNode || !typeNameNode) continue;
    const kind = typeNode.type === 'interface_declaration' ? 'interface' : 'class';
    const methods = collectDirectMethods(typeNode)
      .map((methodNode) => ({
        name: getNodeName(methodNode),
        routes: routesByMethodId.get(methodNode.id) ?? [],
      }))
      .filter((method): method is SpringMethodInfo => method.name !== null);

    out.push({
      filePath,
      kind,
      name: typeNameNode.text,
      classPrefix: prefixByTypeId.get(typeNode.id) ?? '',
      implementedInterfaces: kind === 'class' ? collectImplementedInterfaces(typeNode) : [],
      isController: kind === 'class' && hasAnnotation(typeNode, ['RestController', 'Controller']),
      methods,
    });
  }

  return out;
}

function scanSpringProject(files: readonly HttpScanInput[]): HttpFileDetections[] {
  const types = files.flatMap((file) => collectSpringTypes(file.filePath, file.tree));
  const interfaceRoutes = new Map<string, Map<string, SpringRouteBinding[]> | null>();

  for (const type of types) {
    if (type.kind !== 'interface') continue;
    if (interfaceRoutes.has(type.name)) {
      interfaceRoutes.set(type.name, null);
      continue;
    }
    const methodMap = new Map<string, SpringRouteBinding[]>();
    for (const method of type.methods) {
      const routes = method.routes.map((route) => ({
        method: route.method,
        path: type.classPrefix ? joinPath(type.classPrefix, route.path) : route.path,
      }));
      if (routes.length > 0) methodMap.set(method.name, routes);
    }
    interfaceRoutes.set(type.name, methodMap);
  }

  const detectionsByFile = new Map<string, HttpDetection[]>();
  for (const type of types) {
    if (type.kind !== 'class' || !type.isController) continue;
    for (const method of type.methods) {
      if (method.routes.length > 0) continue;
      const inheritedRoutes = type.implementedInterfaces.flatMap((interfaceName) => {
        const routeMap = interfaceRoutes.get(interfaceName);
        if (!routeMap) return [];
        const routes = routeMap.get(method.name) ?? [];
        return routes.map((route) => ({
          method: route.method,
          path: joinPath(type.classPrefix, route.path),
        }));
      });

      for (const route of inheritedRoutes) {
        const detections = detectionsByFile.get(type.filePath) ?? [];
        detections.push({
          role: 'provider',
          framework: 'spring',
          method: route.method,
          path: route.path,
          name: method.name,
          confidence: 0.8,
        });
        detectionsByFile.set(type.filePath, detections);
      }
    }
  }

  return [...detectionsByFile.entries()].map(([filePath, detections]) => ({
    filePath,
    detections,
  }));
}

export const JAVA_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'java-http',
  language: Java,
  scan(tree) {
    const out: HttpDetection[] = [];

    // ─── Providers: Spring class prefix + method annotations ────────
    const prefixByTypeId = collectTypePrefixes(tree);

    const feignPrefixByInterfaceId = new Map<number, string>();
    for (const match of runCompiledPatterns(FEIGN_INTERFACE_PREFIX_PATTERNS, tree)) {
      const prefixNode = match.captures.prefix;
      const interfaceNode = match.captures.interface;
      if (!prefixNode || !interfaceNode) continue;
      const prefix = unquoteLiteral(prefixNode.text);
      if (prefix !== null && !feignPrefixByInterfaceId.has(interfaceNode.id))
        feignPrefixByInterfaceId.set(interfaceNode.id, prefix);
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
      const enclosingInterface = findEnclosingInterface(methodNode);
      if (enclosingInterface && hasAnnotation(enclosingInterface, 'FeignClient')) {
        const prefix = feignPrefixByInterfaceId.get(enclosingInterface.id) ?? '';
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
      const enclosingClass = findEnclosingClass(methodNode);
      if (!enclosingClass) continue;
      const prefix = prefixByTypeId.get(enclosingClass.id) ?? '';
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

    for (const match of runCompiledPatterns(REST_TEMPLATE_EXCHANGE_PATTERNS, tree)) {
      const httpMethodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!httpMethodNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
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
    // The real long-form chain `webClient.method(HttpMethod.X).uri("/x")`
    // needs multi-hop chain analysis and is intentionally deferred.
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

    // ─── Consumers: Java HttpClient request builder ─────────────────
    // Java's builder exposes GET/POST/PUT/DELETE helpers. PATCH uses
    // `.method("PATCH", body)`, which is intentionally deferred.
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
  scanProject: scanSpringProject,
};
