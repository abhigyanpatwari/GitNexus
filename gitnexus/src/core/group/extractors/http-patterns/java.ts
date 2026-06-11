import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import {
  METHOD_ANNOTATION_TO_HTTP,
  isRouteMemberKey,
  findEnclosingClass,
} from '../../../ingestion/route-extractors/spring-shared.js';
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
 *   - OpenFeign interfaces with Spring MVC method annotations or
 *     native `@RequestLine("METHOD /path")` annotations
 *   - Java / Apache HttpClient literal request construction
 *
 * Every route-defining annotation (class/interface `@RequestMapping`
 * prefixes, `@FeignClient(path)` prefixes, `@(Get|...)Mapping` method
 * routes and native `@RequestLine`s) is matched by a single consolidated
 * query (`JAVA_ROUTE_ANNOTATION_PATTERNS`) in one pass via
 * `scanRouteAnnotations`. The `scan` function then walks up from each
 * matched method to its enclosing class/interface to combine the prefix
 * with the method path. Call-site consumers (RestTemplate, WebClient,
 * OkHttp, Java/Apache HttpClient) keep their own focused queries.
 */

// Each route-defining annotation has two AST shapes — a positional argument
// and a named one — that must both be matched:
//   @RequestMapping("/api")          → (annotation_argument_list (string_literal))
//   @RequestMapping(path = "/api")   → (annotation_argument_list (element_value_pair key:(identifier) value:(string_literal)))
//   @RequestMapping(value = "/api")  → same as above
// For named arguments only the route member keys (`path`/`value`) carry a URL;
// non-route attributes (`produces`, `consumes`, `headers`, `name`, `params`)
// would otherwise be mis-extracted (e.g. `produces = "application/json"` would
// corrupt every route). That key filtering is done in `isRouteMemberKey`, and
// all of these annotations are matched by the one `JAVA_ROUTE_ANNOTATION_PATTERNS`
// query below (see its header for why the filtering lives in JS, not the query).
interface SpringRouteBinding {
  method: string;
  path: string;
  ownerPrefix?: string;
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

// ─── Route-defining annotations (one generic query, one pass) ─────────
// Every Java route-mapper annotation shares one shape: an annotation carrying a
// single string argument — positional `"..."` or named `key = "..."` — on a
// class, interface, or method. This SINGLE query matches that shape generically;
// `scanRouteAnnotations` then reads the annotation NAME (`@ann`) and declaration
// kind (`@node.type`) in its for-loop to decide what each match means. Adding a
// new framework annotation that follows this single-string-argument shape is a
// change to that loop (and the lookup maps), not to this query. Annotations with
// a different argument shape — e.g. an array value `@RequestMapping({"/a","/b"})`
// — are out of scope here (as they were for the prior queries) and would need a
// new branch.
//
// Captures (shared across all branches; intentionally framework-agnostic):
//   @ann    → the annotation name identifier (RequestMapping, GetMapping, RequestLine, …)
//   @node   → the enclosing declaration (class_declaration | interface_declaration | method_declaration)
//   @value  → the string-literal argument
//   @key    → the named-argument member key (absent for the positional shape)
//   @member → the method name (method_declaration branches only)
//
// The query carries NO `#eq?` / `#match?` predicates. Under the pinned
// tree-sitter 0.21.x binding a top-level `[ ... ]` alternation compiles to one
// pattern whose text predicates share a single bucket keyed by capture name, and
// a `#match?` against a capture absent from the matched branch evaluates FALSE —
// silently dropping sibling-branch matches. Keeping the query predicate-free
// sidesteps that hazard entirely; all name/key discrimination lives in the
// for-loop, where it reads as straight-line code.
const JAVA_ROUTE_ANNOTATION_PATTERNS = compilePatterns({
  name: 'java-route-annotation',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        [
          (class_declaration
            (modifiers
              (annotation
                name: (identifier) @ann
                arguments: (annotation_argument_list (string_literal) @value)))) @node
          (interface_declaration
            (modifiers
              (annotation
                name: (identifier) @ann
                arguments: (annotation_argument_list (string_literal) @value)))) @node
          (class_declaration
            (modifiers
              (annotation
                name: (identifier) @ann
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key
                    value: (string_literal) @value))))) @node
          (interface_declaration
            (modifiers
              (annotation
                name: (identifier) @ann
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key
                    value: (string_literal) @value))))) @node
          (method_declaration
            (modifiers
              (annotation
                name: (identifier) @ann
                arguments: (annotation_argument_list (string_literal) @value)))
            name: (identifier) @member) @node
          (method_declaration
            (modifiers
              (annotation
                name: (identifier) @ann
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key
                    value: (string_literal) @value))))
            name: (identifier) @member) @node
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

// ─── Consumer: OpenFeign `@RequestLine("METHOD /path")` parsing ───────
// OpenFeign's native annotation pairs an HTTP method and path in a single
// string literal — see https://github.com/OpenFeign/feign#interface-annotations.
// It is method-level only and is mutually exclusive with Spring MVC
// `@GetMapping` / `@PostMapping` etc. on the same method (mixing them
// requires a different Feign Contract — they are not combined). The match
// itself comes from `JAVA_ROUTE_ANNOTATION_PATTERNS`; this regex splits the
// verb from the path of the captured literal.
//
// Examples:
//   @RequestLine("GET /users/{id}")
//   @RequestLine("POST /users?status=active")
const REQUEST_LINE_VERB_RE = /^\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S.*?)\s*$/i;

/**
 * Parse a Feign `@RequestLine` value into a method + path pair.
 *
 * `@RequestLine("METHOD /path[?query]")` packs both fields in one string;
 * the query portion is dropped because contract IDs are method+path only
 * (consistent with how other consumers like RestTemplate/WebClient drop
 * query strings when their values are inline literals).
 *
 * Returns null if the value is not a recognized HTTP verb followed by a
 * path beginning with `/`.
 */
function parseRequestLine(raw: string): { method: string; path: string } | null {
  const match = REQUEST_LINE_VERB_RE.exec(raw);
  if (!match) return null;
  const [, verb, rest] = match;
  if (typeof verb !== 'string' || typeof rest !== 'string') return null;
  const queryIdx = rest.indexOf('?');
  const pathOnly = (queryIdx >= 0 ? rest.slice(0, queryIdx) : rest).trim();
  if (!pathOnly.startsWith('/')) return null;
  return { method: verb.toUpperCase(), path: pathOnly };
}

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
 * Find the nearest enclosing interface declaration ancestor for a node, or
 * null if the node is top-level.
 */
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

function joinInheritedSpringPath(
  controllerPrefix: string,
  inheritedPath: string,
  inheritedOwnerPrefix = '',
): string {
  const joined = joinPath(controllerPrefix, inheritedPath);
  const cleanPrefix = controllerPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanOwnerPrefix = inheritedOwnerPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanInherited = inheritedPath.replace(/^\/+/, '');
  if (!cleanPrefix) return joined;
  if (
    cleanPrefix === cleanOwnerPrefix &&
    (cleanInherited === cleanPrefix || cleanInherited.startsWith(`${cleanPrefix}/`))
  ) {
    return `/${cleanInherited}`;
  }
  return joined;
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

interface MethodRouteAnnotation {
  methodNode: Parser.SyntaxNode;
  methodName: string | null;
  httpMethod: string;
  rawPath: string;
}

interface RequestLineAnnotation {
  methodNode: Parser.SyntaxNode;
  methodName: string | null;
  parsed: { method: string; path: string };
}

interface RouteAnnotationScan {
  /** Spring `@RequestMapping` URL prefix per class/interface node id (last write wins). */
  prefixByTypeId: Map<number, string>;
  /** OpenFeign interface prefix per interface node id; `@FeignClient(path)` wins over `@RequestMapping`. */
  feignPrefixByInterfaceId: Map<number, string>;
  /** One entry per resolved Spring `@(Get|...)Mapping` route — a method with N mappings yields N entries. */
  methodRoutes: MethodRouteAnnotation[];
  /** One entry per OpenFeign `@RequestLine` whose value parses to a verb + path. */
  requestLines: RequestLineAnnotation[];
}

/**
 * Resolve every Java route-defining annotation in a single tree-sitter pass.
 *
 * The generic `JAVA_ROUTE_ANNOTATION_PATTERNS` query yields one match per
 * annotation-carrying-a-string-argument on any class / interface / method. This
 * loop reads the annotation name and declaration kind to decide what each match
 * means, ignoring annotations it does not recognise. The HTTP verb map
 * (`METHOD_ANNOTATION_TO_HTTP`) and the `path`/`value` key filter
 * (`isRouteMemberKey`) live here rather than in the query (see its header).
 */
function scanRouteAnnotations(tree: Parser.Tree): RouteAnnotationScan {
  const matches = runCompiledPatterns(JAVA_ROUTE_ANNOTATION_PATTERNS, tree);

  // The two prefix maps intentionally diverge for the same interface node:
  // `prefixByTypeId` feeds the Spring *provider* path (class prefix +
  // collectSpringTypes cross-file inheritance), while `feignPrefixByInterfaceId`
  // feeds the OpenFeign *consumer* path in scan(). An interface carrying both
  // `@RequestMapping` and `@FeignClient(path)` lands a different value in each.
  const prefixByTypeId = new Map<number, string>();
  const feignPrefixByInterfaceId = new Map<number, string>();
  const methodRoutes: MethodRouteAnnotation[] = [];
  const requestLines: RequestLineAnnotation[] = [];
  // Interface `@RequestMapping` prefixes rank below `@FeignClient(path)`;
  // collect them and apply only after the FeignClient pass below.
  const interfaceRequestMappingPrefixes: Array<{ id: number; prefix: string }> = [];

  for (const { captures } of matches) {
    const annNode = captures.ann;
    const node = captures.node;
    const valueNode = captures.value;
    if (!annNode || !node || !valueNode) continue;
    const ann = annNode.text;
    const keyNode = captures.key; // undefined for the positional shape

    if (node.type === 'method_declaration') {
      // Method-level: a Spring `@(Get|...)Mapping` route, or native `@RequestLine`.
      const httpMethod = METHOD_ANNOTATION_TO_HTTP[ann];
      if (httpMethod) {
        if (!isRouteMemberKey(keyNode)) continue;
        const rawPath = unquoteLiteral(valueNode.text);
        if (rawPath !== null) {
          methodRoutes.push({
            methodNode: node,
            methodName: captures.member?.text ?? null,
            httpMethod,
            rawPath,
          });
        }
      } else if (ann === 'RequestLine') {
        // Feign packs verb + path in one literal; its only named argument is `value`.
        if (keyNode && keyNode.text !== 'value') continue;
        const raw = unquoteLiteral(valueNode.text);
        const parsed = raw !== null ? parseRequestLine(raw) : null;
        if (parsed) {
          requestLines.push({
            methodNode: node,
            methodName: captures.member?.text ?? null,
            parsed,
          });
        }
      }
      continue;
    }

    // Type-level (class or interface): a Spring `@RequestMapping` URL prefix, or
    // — on an interface — an OpenFeign `@FeignClient(path = "...")` prefix.
    if (ann === 'RequestMapping') {
      if (!isRouteMemberKey(keyNode)) continue;
      const prefix = unquoteLiteral(valueNode.text);
      if (prefix !== null) {
        prefixByTypeId.set(node.id, prefix);
        if (node.type === 'interface_declaration') {
          interfaceRequestMappingPrefixes.push({ id: node.id, prefix });
        }
      }
    } else if (ann === 'FeignClient' && node.type === 'interface_declaration') {
      // Feign's `name`/`value` identify a service, not a path — only `path` is a prefix.
      if (!keyNode || keyNode.text !== 'path') continue;
      const prefix = unquoteLiteral(valueNode.text);
      if (prefix !== null && !feignPrefixByInterfaceId.has(node.id)) {
        feignPrefixByInterfaceId.set(node.id, prefix);
      }
    }
  }

  for (const { id, prefix } of interfaceRequestMappingPrefixes) {
    if (!feignPrefixByInterfaceId.has(id)) feignPrefixByInterfaceId.set(id, prefix);
  }

  return { prefixByTypeId, feignPrefixByInterfaceId, methodRoutes, requestLines };
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
  const { prefixByTypeId, methodRoutes } = scanRouteAnnotations(tree);
  const routesByMethodId = new Map<number, SpringRouteBinding[]>();
  for (const route of methodRoutes) {
    const routes = routesByMethodId.get(route.methodNode.id) ?? [];
    routes.push({ method: route.httpMethod, path: route.rawPath });
    routesByMethodId.set(route.methodNode.id, routes);
  }
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
        ownerPrefix: type.classPrefix,
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
          path: joinInheritedSpringPath(type.classPrefix, route.path, route.ownerPrefix),
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

    // ─── Spring providers + OpenFeign consumers (one query pass) ────
    // `scanRouteAnnotations` resolves every route-defining annotation —
    // class/interface prefixes, method `@(Get|...)Mapping`s and native
    // `@RequestLine`s — from a single `matches()` pass over the tree.
    const { prefixByTypeId, feignPrefixByInterfaceId, methodRoutes, requestLines } =
      scanRouteAnnotations(tree);

    // A `@(Get|...)Mapping` inside a `@FeignClient` interface is an OpenFeign
    // *consumer* (it describes a remote call); the same annotation inside a
    // class is a Spring *provider*. A mapping on a non-Feign interface has no
    // enclosing class and is dropped here — interface→controller inheritance is
    // handled by `scanProject`.
    for (const route of methodRoutes) {
      const enclosingInterface = findEnclosingInterface(route.methodNode);
      if (enclosingInterface && hasAnnotation(enclosingInterface, 'FeignClient')) {
        const prefix = feignPrefixByInterfaceId.get(enclosingInterface.id) ?? '';
        out.push({
          role: 'consumer',
          framework: 'openfeign',
          method: route.httpMethod,
          path: joinPath(prefix, route.rawPath),
          name: route.methodName,
          confidence: 0.7,
        });
        continue;
      }
      const enclosingClass = findEnclosingClass(route.methodNode);
      if (!enclosingClass) continue;
      const prefix = prefixByTypeId.get(enclosingClass.id) ?? '';
      out.push({
        role: 'provider',
        framework: 'spring',
        method: route.httpMethod,
        path: joinPath(prefix, route.rawPath),
        name: route.methodName,
        confidence: 0.8,
      });
    }

    // Native OpenFeign `@RequestLine("METHOD /path")`. Method-level only and
    // always declared on an interface (Feign builds a proxy from the interface).
    // We do NOT require an enclosing `@FeignClient`: `@RequestLine` is a core
    // `feign.*` annotation used with `Feign.builder()`, whereas `@FeignClient`
    // is the Spring Cloud variant that uses Spring MVC annotations instead — the
    // two are effectively mutually exclusive, so requiring `@FeignClient` here
    // would miss the annotation's primary use. The `RequestLine` name is itself
    // a strong, framework-specific signal, so a structural interface check is
    // enough to keep false positives away. A `@FeignClient(path=...)` prefix is
    // still applied when present (rare, but harmless).
    for (const requestLine of requestLines) {
      const enclosingInterface = findEnclosingInterface(requestLine.methodNode);
      if (!enclosingInterface) continue;
      const prefix = feignPrefixByInterfaceId.get(enclosingInterface.id) ?? '';
      out.push({
        role: 'consumer',
        framework: 'openfeign',
        method: requestLine.parsed.method,
        path: joinPath(prefix, requestLine.parsed.path),
        name: requestLine.methodName,
        confidence: 0.75,
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
