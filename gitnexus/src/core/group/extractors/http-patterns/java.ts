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
  joinPath,
  type SharedSpringType,
} from '../../../ingestion/route-extractors/spring-shared.js';
import {
  REST_TEMPLATE_TO_HTTP,
  WEB_CLIENT_SHORT_TO_HTTP,
  WEB_CLIENT_LONG_VERB_RE,
  EXCHANGE_ANNOTATION_TO_HTTP,
  parseRequestLine,
  pushPrefix,
  scanSpringInheritanceProject,
  OPENFEIGN_FRAMEWORK,
  HTTP_INTERFACE_FRAMEWORK,
  FEIGN_CONFIDENCE,
  REQUEST_LINE_CONFIDENCE,
  EXCHANGE_CONFIDENCE,
} from './spring-consumer-shared.js';
import {
  extractStaticPathExpression,
  inferOkHttpMethod,
  inferHttpClientMethod,
  okHttpUrlRootsAtBuilder,
  httpClientUriRootsAtNewBuilder,
  httpClientChainHasUriCall,
} from './java-static-path.js';
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
// The Spring class/interface view (`SharedSpringType`) and the interface-based
// controller inheritance algorithm (`scanSpringInheritanceProject`) are shared
// with kotlin.ts via spring-consumer-shared.ts so both plugins emit identical
// provider contracts. `collectSpringTypes` below produces that shared shape.

// ─── Route-defining annotations (one generic query, one pass) ─────────
// Every Java route-mapper annotation shares one shape: an annotation carrying a
// string argument — positional `"..."` or named `key = "..."`, each also in its
// array form `{"..."}` / `key = {"..."}` (Spring's `path`/`value` are
// `String[]`) — on a class, interface, or method. This SINGLE query matches that
// shape generically; the `@value` capture is an alternation over a bare
// `string_literal` and one nested in an `element_value_array_initializer`, so a
// single-element array yields the same `@value` (a multi-element array yields one
// match per element). `scanRouteAnnotations` then reads the annotation NAME
// (`@ann`) and declaration kind (`@node.type`) in its for-loop to decide what
// each match means. Adding a new framework annotation that follows this shape is
// a change to that loop (and the lookup maps), not to this query.
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
//
// FULLY-QUALIFIED route annotations ARE matched. `@ann` binds either an
// `identifier` (simple name) or a `scoped_identifier` (a FQN annotation such as
// `@org.springframework…GetMapping("/x")`); the for-loop normalizes the name to
// its trailing segment via `simpleName` before discriminating. This is a node-
// type widening only — the query stays predicate-free, so it does NOT reintroduce
// the bucket hazard above, and a simple name maps to itself so existing Java
// contracts are unchanged (only previously-unmatched FQN annotations gain
// routes). This brings Java to parity with the Kotlin plugin, whose grammar
// already matches FQN route annotations.
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
                name: [(identifier) (scoped_identifier)] @ann
                arguments: (annotation_argument_list [(string_literal) @value (element_value_array_initializer (string_literal) @value)])))) @node
          (interface_declaration
            (modifiers
              (annotation
                name: [(identifier) (scoped_identifier)] @ann
                arguments: (annotation_argument_list [(string_literal) @value (element_value_array_initializer (string_literal) @value)])))) @node
          (class_declaration
            (modifiers
              (annotation
                name: [(identifier) (scoped_identifier)] @ann
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key
                    value: [(string_literal) @value (element_value_array_initializer (string_literal) @value)]))))) @node
          (interface_declaration
            (modifiers
              (annotation
                name: [(identifier) (scoped_identifier)] @ann
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key
                    value: [(string_literal) @value (element_value_array_initializer (string_literal) @value)]))))) @node
          (method_declaration
            (modifiers
              (annotation
                name: [(identifier) (scoped_identifier)] @ann
                arguments: (annotation_argument_list [(string_literal) @value (element_value_array_initializer (string_literal) @value)])))
            name: (identifier) @member) @node
          (method_declaration
            (modifiers
              (annotation
                name: [(identifier) (scoped_identifier)] @ann
                arguments: (annotation_argument_list
                  (element_value_pair
                    key: (identifier) @key
                    value: [(string_literal) @value (element_value_array_initializer (string_literal) @value)]))))
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

// OpenFeign `@RequestLine` parsing (`parseRequestLine`), the RestTemplate and
// WebClient short-form verb maps, the `@*Exchange` verb map, `joinPath`, and the
// shared confidence/framework constants live in `spring-consumer-shared.ts` so
// the Java and Kotlin plugins emit identical contract IDs.

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

// ─── Consumer: WebClient long form `webClient.method(HttpMethod.X).uri("/y")` ─
// The fluent long form carries the verb as a `HttpMethod.X` field access through
// `.method(...)` and the path on a separate `.uri(...)` hop. A single structural
// query matches the whole chain (the same field-access shape used by
// REST_TEMPLATE_EXCHANGE_PATTERNS) — the earlier "intentionally deferred" note
// predated the Kotlin plugin proving the structural query is enough. Variable-
// bound verbs (`webClient.method(verb).uri(...)`) do NOT match: the value carries
// a bare `identifier`, not a `HttpMethod.X` field access — source-scan can't
// follow the binding (anti-overreach test pins this, parity with Kotlin).
const WEB_CLIENT_LONG_FORM_PATTERNS = compilePatterns({
  name: 'java-web-client-long-form',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (method_invocation
            object: (identifier) @obj (#eq? @obj "webClient")
            name: (identifier) @method_call (#eq? @method_call "method")
            arguments: (argument_list
              (field_access
                object: (identifier) @httpMethodCls (#eq? @httpMethodCls "HttpMethod")
                field: (identifier) @verb)))
          name: (identifier) @uri_method (#eq? @uri_method "uri")
          arguments: (argument_list . (string_literal) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// ─── Consumer: OkHttp `Request.Builder()…url("path")` ─────────────────
// Match a bare `.url("literal")` call on ANY receiver, capturing it as `@call`.
// `okHttpUrlRootsAtBuilder` (JS) then verifies the receiver chain bottoms out on
// `new Request.Builder()` — re-imposing the framework anchor while allowing
// builder calls BEFORE `.url()` (`new Request.Builder().addHeader(...).url("/x")`)
// that the old object-direct query dropped, and rejecting a `.url(...)` on an
// unrelated object. The verb is recovered by `inferOkHttpMethod` scanning the
// whole chain (java-static-path.ts).
const OK_HTTP_PATTERNS = compilePatterns({
  name: 'java-okhttp',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          name: (identifier) @method (#eq? @method "url")
          arguments: (argument_list . (string_literal) @path)) @call
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Match a bare `.uri(URI.create("literal"))` call on ANY receiver, capturing it
// as `@call`. `httpClientUriRootsAtNewBuilder` (JS) verifies the chain includes
// `HttpRequest.newBuilder()` — allowing calls BEFORE `.uri()` (`.version(v)`
// `.uri(...)`) that the old object-direct query dropped, and rejecting a `.uri(...)`
// on an unrelated object (e.g. WebClient). The verb (a `.GET()/.POST()/.PUT()/`
// `.DELETE()/.HEAD()` helper, a `.method("VERB", body)` literal, or the bare-build
// default) is recovered by `inferHttpClientMethod` scanning the whole chain.
// Matching `.uri(...)` regardless of a trailing `.build()` mirrors the accepted
// OkHttp over-match posture.
const JAVA_HTTP_CLIENT_PATTERNS = compilePatterns({
  name: 'java-http-client',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          name: (identifier) @uri_method (#eq? @uri_method "uri")
          arguments: (argument_list
            (method_invocation
              object: (identifier) @uriCls (#eq? @uriCls "URI")
              name: (identifier) @create (#eq? @create "create")
              arguments: (argument_list . (string_literal) @path)))) @call
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Constructor-arg form: `HttpRequest.newBuilder(URI.create("..."))` — the path is
// the `newBuilder(...)` argument, with no `.uri()` call. Captures the `newBuilder`
// call as `@call`; the emission skips it when a later `.uri(...)` overrides the
// constructor URI (`httpClientChainHasUriCall`), so the `.uri()` query owns that case.
const JAVA_HTTP_CLIENT_CTOR_PATTERNS = compilePatterns({
  name: 'java-http-client-ctor',
  language: Java,
  patterns: [
    {
      meta: {},
      query: `
        (method_invocation
          object: (identifier) @builderCls (#eq? @builderCls "HttpRequest")
          name: (identifier) @newBuilder (#eq? @newBuilder "newBuilder")
          arguments: (argument_list
            (method_invocation
              object: (identifier) @uriCls (#eq? @uriCls "URI")
              name: (identifier) @create (#eq? @create "create")
              arguments: (argument_list . (string_literal) @path)))) @call
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

function getNodeName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

/**
 * Trailing segment of a possibly fully-qualified annotation name
 * (`org.springframework.web.bind.annotation.GetMapping` → `GetMapping`). The
 * route query binds `@ann` to either an `identifier` (simple) or a
 * `scoped_identifier` (FQN); normalizing here lets the one for-loop discriminate
 * on the simple name in both cases. A simple name maps to itself, so this never
 * changes how a non-FQN annotation is classified.
 */
function simpleName(text: string): string {
  return text.split('.').pop() ?? text;
}

function hasAnnotation(node: Parser.SyntaxNode, names: string | readonly string[]): boolean {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  if (!modifiers) return false;
  const allowed = new Set(typeof names === 'string' ? [names] : names);
  const stack = [...modifiers.namedChildren];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const annotationName = cur.childForFieldName('name')?.text ?? '';
    if (
      (cur.type === 'annotation' || cur.type === 'marker_annotation') &&
      (allowed.has(annotationName) || allowed.has(simpleName(annotationName)))
    ) {
      return true;
    }
    stack.push(...cur.namedChildren);
  }
  return false;
}

// The statically-resolvable consumer path helpers (URI.create /
// UriComponentsBuilder resolution) and the OkHttp / HttpClient builder verb-walks
// (`inferOkHttpMethod` / `inferHttpClientMethod`) live in ./java-static-path.ts
// (#2268), shared with the RestTemplate, OkHttp, and HttpClient consumer loops.

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
  /** Spring `@RequestMapping` URL prefixes per class/interface node id (one per array element). */
  prefixByTypeId: Map<number, string[]>;
  /** OpenFeign interface prefixes per interface node id; `@FeignClient(path)` wins over `@RequestMapping`. */
  feignPrefixByInterfaceId: Map<number, string[]>;
  /** Spring HTTP Interface `@HttpExchange(url|value)` type-level prefixes per class/interface node id. */
  httpExchangePrefixByTypeId: Map<number, string[]>;
  /** One entry per resolved Spring `@(Get|...)Mapping` route — a method with N mappings yields N entries. */
  methodRoutes: MethodRouteAnnotation[];
  /** One entry per OpenFeign `@RequestLine` whose value parses to a verb + path. */
  requestLines: RequestLineAnnotation[];
  /** One entry per Spring HTTP Interface `@(Get|...)Exchange` method — always a consumer. */
  exchangeRoutes: MethodRouteAnnotation[];
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
  const prefixByTypeId = new Map<number, string[]>();
  const feignPrefixByInterfaceId = new Map<number, string[]>();
  const httpExchangePrefixByTypeId = new Map<number, string[]>();
  const methodRoutes: MethodRouteAnnotation[] = [];
  const requestLines: RequestLineAnnotation[] = [];
  const exchangeRoutes: MethodRouteAnnotation[] = [];
  // Interface `@RequestMapping` prefixes rank below `@FeignClient(path)`;
  // collect them and apply only after the FeignClient pass below.
  const interfaceRequestMappingPrefixes: Array<{ id: number; prefix: string }> = [];
  // `pushPrefix` (the de-duping accumulator) is shared from
  // spring-consumer-shared.ts so Java and Kotlin build prefix maps identically.

  for (const { captures } of matches) {
    const annNode = captures.ann;
    const node = captures.node;
    const valueNode = captures.value;
    if (!annNode || !node || !valueNode) continue;
    // Discrimination is on the trailing segment only (`simpleName`), so a
    // non-Spring annotation whose last segment collides with a route annotation
    // (e.g. `@com.evil.GetMapping("/x")`) is treated as a route. This is the
    // same accepted trailing-segment trade-off `hasAnnotation` already makes and
    // the intended parity with the Kotlin plugin — package-origin gating would
    // break that parity and is deliberately not done.
    const ann = simpleName(annNode.text);
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
      } else if (EXCHANGE_ANNOTATION_TO_HTTP[ann]) {
        // Spring 6 HTTP Interface `@(Get|...)Exchange` — the path lives in the
        // `url` or `value` attribute (or positionally); other attributes
        // (`accept`, `contentType`, …) are not routes.
        if (keyNode && keyNode.text !== 'url' && keyNode.text !== 'value') continue;
        const rawPath = unquoteLiteral(valueNode.text);
        if (rawPath !== null) {
          exchangeRoutes.push({
            methodNode: node,
            methodName: captures.member?.text ?? null,
            httpMethod: EXCHANGE_ANNOTATION_TO_HTTP[ann],
            rawPath,
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
        pushPrefix(prefixByTypeId, node.id, prefix);
        if (node.type === 'interface_declaration') {
          interfaceRequestMappingPrefixes.push({ id: node.id, prefix });
        }
      }
    } else if (ann === 'FeignClient' && node.type === 'interface_declaration') {
      // Feign's `name`/`value` identify a service, not a path — only `path` is a prefix.
      if (!keyNode || keyNode.text !== 'path') continue;
      const prefix = unquoteLiteral(valueNode.text);
      if (prefix !== null) pushPrefix(feignPrefixByInterfaceId, node.id, prefix);
    } else if (ann === 'HttpExchange') {
      // Spring HTTP Interface type-level prefix: the path lives in `url`/`value`
      // (or positionally). Applies to its `@(Get|...)Exchange` consumer methods.
      if (keyNode && keyNode.text !== 'url' && keyNode.text !== 'value') continue;
      const prefix = unquoteLiteral(valueNode.text);
      if (prefix !== null) pushPrefix(httpExchangePrefixByTypeId, node.id, prefix);
    }
  }

  // `@RequestMapping` on a Feign interface is the fallback prefix, but only when
  // the interface has no `@FeignClient(path)` of its own (path wins).
  for (const { id, prefix } of interfaceRequestMappingPrefixes) {
    if (!feignPrefixByInterfaceId.has(id)) pushPrefix(feignPrefixByInterfaceId, id, prefix);
  }

  return {
    prefixByTypeId,
    feignPrefixByInterfaceId,
    httpExchangePrefixByTypeId,
    methodRoutes,
    requestLines,
    exchangeRoutes,
  };
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

function collectSpringTypes(filePath: string, tree: Parser.Tree): SharedSpringType[] {
  const { prefixByTypeId, methodRoutes } = scanRouteAnnotations(tree);
  const routesByMethodId = new Map<number, Array<{ method: string; path: string }>>();
  for (const route of methodRoutes) {
    const routes = routesByMethodId.get(route.methodNode.id) ?? [];
    routes.push({ method: route.httpMethod, path: route.rawPath });
    routesByMethodId.set(route.methodNode.id, routes);
  }
  const out: SharedSpringType[] = [];

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
      .filter(
        (method): method is { name: string; routes: Array<{ method: string; path: string }> } =>
          method.name !== null,
      );

    out.push({
      filePath,
      kind,
      name: typeNameNode.text,
      classPrefixes: prefixByTypeId.get(typeNode.id) ?? [],
      implementedInterfaces: kind === 'class' ? collectImplementedInterfaces(typeNode) : [],
      isController: kind === 'class' && hasAnnotation(typeNode, ['RestController', 'Controller']),
      methods,
    });
  }

  return out;
}

// The interface-based-controller inheritance algorithm is shared with kotlin.ts
// (`scanSpringInheritanceProject`); this collects the `SharedSpringType` view and
// delegates so Java and Kotlin emit byte-identical provider contracts.
function scanSpringProject(files: readonly HttpScanInput[]): HttpFileDetections[] {
  return scanSpringInheritanceProject(
    files.flatMap((file) => collectSpringTypes(file.filePath, file.tree)),
  );
}

export const JAVA_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'java-http',
  language: Java,
  // routeCoverage intentionally LEFT at the default 'partial' (#2138 Part 2).
  // The graph provider set is a strict *subset* of this scan()'s provider set —
  // ingestion does NOT emit a Route node for (1) a method-level array route
  // nested under a class-level array-form `@RequestMapping` (ingestion suppresses
  // it rather than drop the prefix; bare/scalar-prefixed array methods ARE now
  // emitted — see #2280), or (2) the 2nd verb of a same-URL GET+POST pair (Route
  // nodes are URL-keyed). Interface-inherited Spring routes ARE now emitted by
  // ingestion (#2288), so they are no longer a coverage gap. Declaring 'complete'
  // here would let the parse-skip drop those remaining group-only providers.
  // Java flips to 'complete' only once ingestion provider extraction matches this
  // scan (a follow-up: class-level array-form prefix support + per-verb Route
  // identity — tracked in #2280).
  // `hasConsumerSignals` below is kept ready for that flip.
  // Consumer signals this plugin's scan() can detect: RestTemplate / WebClient /
  // OkHttp / Java-HttpClient / Apache-HttpClient call sites, OpenFeign
  // (`@FeignClient` + `@RequestLine`) interfaces, and Spring 6 HTTP Interface
  // `@(Get|...)Exchange` / `@HttpExchange`. A provider-covered file containing
  // any of these must still be parsed so its consumer contracts are not dropped
  // (ingestion emits no FETCHES for Java). Conservative by design.
  hasConsumerSignals(content) {
    return /\brestTemplate\b|\bwebClient\b|Request\.Builder|HttpRequest|HttpMethod\.|new\s+Http(Get|Post|Put|Delete|Patch)\b|@RequestLine|@FeignClient|Exchange/.test(
      content,
    );
  },
  scan(tree) {
    const out: HttpDetection[] = [];

    // ─── Spring providers + OpenFeign consumers (one query pass) ────
    // `scanRouteAnnotations` resolves every route-defining annotation —
    // class/interface prefixes, method `@(Get|...)Mapping`s and native
    // `@RequestLine`s — from a single `matches()` pass over the tree.
    const {
      prefixByTypeId,
      feignPrefixByInterfaceId,
      httpExchangePrefixByTypeId,
      methodRoutes,
      requestLines,
      exchangeRoutes,
    } = scanRouteAnnotations(tree);

    // A `@(Get|...)Mapping` inside a `@FeignClient` interface is an OpenFeign
    // *consumer* (it describes a remote call); the same annotation inside a
    // class is a Spring *provider*. A mapping on a non-Feign interface has no
    // enclosing class and is dropped here — interface→controller inheritance is
    // handled by `scanProject`.
    for (const route of methodRoutes) {
      const enclosingInterface = findEnclosingInterface(route.methodNode);
      if (enclosingInterface && hasAnnotation(enclosingInterface, 'FeignClient')) {
        const prefixes = feignPrefixByInterfaceId.get(enclosingInterface.id) ?? [''];
        for (const prefix of prefixes) {
          out.push({
            role: 'consumer',
            framework: OPENFEIGN_FRAMEWORK,
            method: route.httpMethod,
            path: joinPath(prefix, route.rawPath),
            name: route.methodName,
            line: route.methodNode.startPosition.row + 1,
            confidence: FEIGN_CONFIDENCE,
          });
        }
        continue;
      }
      const enclosingClass = findEnclosingClass(route.methodNode);
      if (!enclosingClass) continue;
      // A multi-element class `@RequestMapping({"/a","/b"})` registers the method
      // under each prefix — emit one provider per (prefix × this route).
      const prefixes = prefixByTypeId.get(enclosingClass.id) ?? [''];
      for (const prefix of prefixes) {
        out.push({
          role: 'provider',
          framework: 'spring',
          method: route.httpMethod,
          path: joinPath(prefix, route.rawPath),
          name: route.methodName,
          // Spring providers are named controller methods resolved BY NAME, so
          // `line` is inert — a named provider never falls through to line-span
          // containment. Gate it on a present name so a (grammar-impossible)
          // nameless provider degrades to file-level rather than resolving by
          // containment to the enclosing class. Wired for consumer-emit parity
          // and a future inline DSL.
          line: route.methodName ? route.methodNode.startPosition.row + 1 : undefined,
          confidence: 0.8,
        });
      }
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
      const prefixes = feignPrefixByInterfaceId.get(enclosingInterface.id) ?? [''];
      for (const prefix of prefixes) {
        out.push({
          role: 'consumer',
          framework: OPENFEIGN_FRAMEWORK,
          method: requestLine.parsed.method,
          path: joinPath(prefix, requestLine.parsed.path),
          name: requestLine.methodName,
          line: requestLine.methodNode.startPosition.row + 1,
          confidence: REQUEST_LINE_CONFIDENCE,
        });
      }
    }

    // ─── Consumers: Spring HTTP Interface @(Get|...)Exchange ────────
    // Declarative client interfaces proxied by `HttpServiceProxyFactory`
    // (over RestClient / WebClient / RestTemplate). Always a consumer — no
    // provider ambiguity — with an optional type-level `@HttpExchange(url)`
    // prefix. The verb comes from the annotation name (`@GetExchange` → GET).
    for (const route of exchangeRoutes) {
      const enclosing =
        findEnclosingInterface(route.methodNode) ?? findEnclosingClass(route.methodNode);
      const prefixes = enclosing ? (httpExchangePrefixByTypeId.get(enclosing.id) ?? ['']) : [''];
      for (const prefix of prefixes) {
        out.push({
          role: 'consumer',
          framework: HTTP_INTERFACE_FRAMEWORK,
          method: route.httpMethod,
          path: joinPath(prefix, route.rawPath),
          name: route.methodName,
          line: route.methodNode.startPosition.row + 1,
          confidence: EXCHANGE_CONFIDENCE,
        });
      }
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
        line: pathNode.startPosition.row + 1,
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
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // ─── Consumers: WebClient.get().uri("path") short form ─────────
    // Source-scan only: receiver must be named exactly `webClient`. The
    // long-form chain `webClient.method(HttpMethod.X).uri("/x")` is handled
    // separately below by WEB_CLIENT_LONG_FORM_PATTERNS.
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
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // ─── Consumers: WebClient.method(HttpMethod.X).uri("path") long form ─
    // The verb is captured as the literal `HttpMethod.X` field name; gate it on
    // the shared verb regex (HEAD/OPTIONS/TRACE excluded, matching the short
    // form). The short-form query requires an empty inner argument list, so it
    // cannot also fire on this chain — no double-emit.
    for (const match of runCompiledPatterns(WEB_CLIENT_LONG_FORM_PATTERNS, tree)) {
      const verbNode = match.captures.verb;
      const pathNode = match.captures.path;
      if (!verbNode || !pathNode) continue;
      const verbText = verbNode.text;
      if (!WEB_CLIENT_LONG_VERB_RE.test(verbText)) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'spring-web-client',
        method: verbText,
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // ─── Consumers: OkHttp Request.Builder().url("path") ────────────
    // Match any `.url("literal")`, gate to chains rooting at `new Request.Builder()`
    // (so a call before `.url()` is captured but an unrelated `.url()` is not), then
    // recover the verb (`.post()`/`.method("X")`) by scanning the builder chain.
    for (const match of runCompiledPatterns(OK_HTTP_PATTERNS, tree)) {
      const callNode = match.captures.call;
      const pathNode = match.captures.path;
      if (!callNode || !pathNode) continue;
      if (!okHttpUrlRootsAtBuilder(callNode)) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      const method = inferOkHttpMethod(callNode);
      // An explicit `.method(verb, …)` with a non-literal or empty verb is
      // unresolvable (null) — emit nothing rather than a wrong GET or an empty
      // `http::::/path` contract.
      if (!method) continue;
      out.push({
        role: 'consumer',
        framework: 'okhttp',
        method,
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    }

    // ─── Consumers: Java HttpClient request builder ─────────────────
    // Match any `.uri(URI.create("..."))`, gate to chains including `HttpRequest`
    // `.newBuilder()` (so a call before `.uri()` is captured but an unrelated
    // `.uri()` is not); `inferHttpClientMethod` scans the chain for the verb — a
    // `.GET()/.POST()/.PUT()/.DELETE()/.HEAD()` helper, a `.method("VERB", body)`
    // literal, or the bare-build default GET. A variable-bound `.method(verb, …)`
    // is unresolvable → emit nothing. Mirrors the OkHttp loop above. The
    // constructor-arg form (`newBuilder(URI.create(...))`, no `.uri()`) follows.
    for (const match of runCompiledPatterns(JAVA_HTTP_CLIENT_PATTERNS, tree)) {
      const callNode = match.captures.call;
      const pathNode = match.captures.path;
      if (!callNode || !pathNode) continue;
      if (!httpClientUriRootsAtNewBuilder(callNode)) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      const method = inferHttpClientMethod(callNode);
      if (!method) continue;
      out.push({
        role: 'consumer',
        framework: 'java-http-client',
        method,
        path,
        name: null,
        confidence: 0.65,
      });
    }

    // Constructor-arg form: `HttpRequest.newBuilder(URI.create("..."))` with the
    // path in the constructor and no overriding `.uri(...)` later in the chain
    // (a later `.uri()` wins at runtime, so the loop above owns that case).
    for (const match of runCompiledPatterns(JAVA_HTTP_CLIENT_CTOR_PATTERNS, tree)) {
      const callNode = match.captures.call;
      const pathNode = match.captures.path;
      if (!callNode || !pathNode) continue;
      if (httpClientChainHasUriCall(callNode)) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      const method = inferHttpClientMethod(callNode);
      if (!method) continue;
      out.push({
        role: 'consumer',
        framework: 'java-http-client',
        method,
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
