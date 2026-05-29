import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Kotlin HTTP plugin (Spring providers + consumers).
 *
 * **Providers** (#1849) — Spring `@RequestMapping` class prefixes and
 * `@(Get|Post|...)Mapping` method annotations on Kotlin Spring Boot
 * controllers. Both positional shorthand (`@GetMapping("/x")`) and
 * named annotation arguments (`@GetMapping(value = "/x")` and
 * `@GetMapping(path = "/x")`) are supported.
 *
 * **Consumers** — four call-site patterns common in Kotlin
 * Spring projects:
 *
 *   1. `restTemplate.getForObject("/x", ...)` and friends (#1855)
 *   2. `webClient.get().uri("/x")` — short form (#1855)
 *   3. `Request.Builder().url("/x")` — OkHttp (#1855)
 *   4. `webClient.method(HttpMethod.X).uri("/y")` — long form (this PR)
 *
 * The long form puts the verb on a sibling `call_expression` two hops
 * away from the path. Rather than introducing imperative walk-up logic,
 * we use a single deeper tree-sitter query that matches the full chain
 * structurally — see `WEB_CLIENT_LONG_PATTERNS` below. The verb is
 * captured directly as the `simple_identifier` of `HttpMethod.X`, so
 * variable-bound verbs (`val verb = HttpMethod.PATCH; webClient.method(verb)...`)
 * are intentionally NOT picked up — those need a graph-aware resolver
 * and are out of scope for source-scan.
 *
 * tree-sitter-kotlin (fwcd) AST shapes used here:
 *   class_declaration
 *     modifiers
 *       annotation
 *         constructor_invocation
 *           user_type → type_identifier   ← annotation name
 *           value_arguments
 *             value_argument
 *               (simple_identifier  "=")? ← absent for positional, present for named
 *               string_literal
 *     type_identifier                     ← class name
 *
 * Consumer call shape (Kotlin chains everything via `navigation_expression`):
 *   call_expression                       ← outer `.uri("/x")` or `.url("/x")`
 *     navigation_expression
 *       call_expression                   ← inner `.get()` / `Request.Builder()` / `restTemplate.x`
 *         navigation_expression
 *           simple_identifier             ← receiver: `webClient` / `Request` / `restTemplate`
 *           navigation_suffix             ← `.method` / `.Builder` / `.getForObject`
 *         call_suffix (value_arguments)
 *       navigation_suffix                 ← `.uri` / `.url`
 *     call_suffix
 *       value_arguments
 *         value_argument
 *           string_literal                ← the path
 *
 * tree-sitter-kotlin is an optional npm dependency — when its native
 * binding is unavailable the plugin gracefully exports `null` and
 * `http-patterns/index.ts` skips registration for `.kt`/`.kts` files.
 */

const _require = createRequire(import.meta.url);

/** Loaded lazily; null when the grammar binding isn't installed. */
let Kotlin: unknown | null = null;
try {
  Kotlin = _require('tree-sitter-kotlin');
} catch {
  Kotlin = null;
}

const METHOD_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/**
 * RestTemplate method-name → HTTP verb. Mirrors the Java plugin's
 * `REST_TEMPLATE_TO_HTTP` (java.ts) so a polyglot repo emits the
 * same contract IDs from .java and .kt sources.
 */
const REST_TEMPLATE_TO_HTTP: Record<string, string> = {
  getForObject: 'GET',
  getForEntity: 'GET',
  postForObject: 'POST',
  postForEntity: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patchForObject: 'PATCH',
};

/**
 * WebClient short-form verb → HTTP verb. The reactive WebClient API
 * exposes `.get()`, `.post()`, `.put()`, `.delete()`, `.patch()` as
 * one-liners that return a `RequestHeadersUriSpec` whose `.uri(...)`
 * carries the path. We capture both pieces in a single query (see
 * `WEB_CLIENT_SHORT_PATTERNS` below) and translate the verb here.
 */
const WEB_CLIENT_SHORT_TO_HTTP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

/**
 * Allowed HTTP verbs for the WebClient long-form path
 * `webClient.method(HttpMethod.X).uri("/y")`. Compiled once at module
 * load (instead of inside the scan loop) per maintainer feedback on
 * PR #1884. Mirrors the keys of `WEB_CLIENT_SHORT_TO_HTTP` above —
 * keeping HEAD/OPTIONS/TRACE intentionally excluded for symmetry
 * with the short form and the Java plugin.
 */
const WEB_CLIENT_LONG_VERB_RE = /^(GET|POST|PUT|DELETE|PATCH)$/;

/**
 * Build the plugin only if the Kotlin grammar is available. Compiling
 * the queries against a null grammar would throw at module load time
 * and abort the whole http-route-extractor module.
 */
function buildKotlinPlugin(language: unknown): HttpLanguagePlugin {
  // ─── Provider: Spring class-level @RequestMapping prefix ──────────────
  // Two patterns mirror the Java plugin's positional vs named split:
  //   @RequestMapping("/api")          → value_argument has string_literal as its first named child
  //   @RequestMapping(path = "/api")   → value_argument has [simple_identifier @key, string_literal]
  //   @RequestMapping(value = "/api")  → same as above, with key="value"
  //
  // Tree-sitter-kotlin grammar (fwcd 0.3.8) does NOT have a separate
  // node for named arguments — both positional and named forms share
  // `value_argument`. The positional pattern uses the immediate-child
  // anchor `.` so it only matches when the string_literal is the FIRST
  // named child (i.e. no preceding simple_identifier "=" prefix). The
  // named pattern explicitly captures the simple_identifier and uses
  // `#match?` to restrict it to `path`/`value`, matching the same
  // safety bar that the Java plugin enforces (see java.ts and the
  // sibling topic-patterns/java.ts for the analogous constraint).
  //
  // Without the `key:` constraint the named query would also capture
  // unrelated attributes like `produces`, `consumes`, `headers`,
  // `name`, `params` — emitting bogus route contracts (a regression
  // identical to the one Claude flagged on PR #1834 for Java).
  const SPRING_CLASS_PREFIX_PATTERNS = compilePatterns({
    name: 'kotlin-spring-class-prefix',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "RequestMapping"))
                  (value_arguments
                    (value_argument . (string_literal) @prefix)))))
            (type_identifier) @cls) @class
        `,
      },
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "RequestMapping"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(path|value)$")
                      (string_literal) @prefix)))))
            (type_identifier) @cls) @class
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Provider: Spring @(Get|Post|...)Mapping method annotations ───────
  // Same dual-pattern positional/named approach. The Kotlin AST puts the
  // function name (`simple_identifier`) outside the `modifiers` subtree,
  // so we capture it from `function_declaration` directly.
  const SPRING_METHOD_ROUTE_PATTERNS = compilePatterns({
    name: 'kotlin-spring-method-route',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (function_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$"))
                  (value_arguments
                    (value_argument . (string_literal) @path)))))
            (simple_identifier) @method_name) @method
        `,
      },
      {
        meta: {},
        query: `
          (function_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(path|value)$")
                      (string_literal) @path)))))
            (simple_identifier) @method_name) @method
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer: Spring RestTemplate ────────────────────────────────────
  // Kotlin call-site shape mirrors the Java plugin's
  // `REST_TEMPLATE_PATTERNS`, but goes through tree-sitter-kotlin's
  // `navigation_expression` instead of Java's `method_invocation`:
  //
  //   restTemplate.getForObject("/x", User::class.java)
  //
  // becomes
  //
  //   call_expression
  //     navigation_expression
  //       simple_identifier "restTemplate"
  //       navigation_suffix → simple_identifier "getForObject"
  //     call_suffix
  //       value_arguments
  //         value_argument . string_literal "/x"   ← captured
  //         value_argument User::class.java
  //
  // The receiver name is constrained to `restTemplate` (#eq? @obj),
  // matching the Java plugin's heuristic. This means a non-conventional
  // field name (e.g. `userServiceTemplate`) will not be picked up;
  // that's the same trade-off already accepted on the Java side.
  const REST_TEMPLATE_PATTERNS = compilePatterns({
    name: 'kotlin-rest-template',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (call_expression
            (navigation_expression
              (simple_identifier) @obj (#eq? @obj "restTemplate")
              (navigation_suffix (simple_identifier) @method))
            (call_suffix
              (value_arguments . (value_argument . (string_literal) @path))))
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer: Spring WebClient (short form) ──────────────────────────
  // Reactive WebClient exposes one-liner verb helpers:
  //
  //   webClient.get().uri("/x").retrieve().awaitBody<T>()
  //   webClient.post().uri("/x")...
  //
  // The chain `webClient.get().uri("/x")` parses as two nested
  // `call_expression` nodes — the OUTER call is `.uri("/x")` and the
  // INNER call is `webClient.get()`. We anchor on the outer call and
  // require:
  //   - inner receiver is `webClient`
  //   - inner suffix is one of the HTTP verbs (#match?)
  //   - outer suffix is exactly `uri`
  //   - outer call's first value_argument is a string literal
  //
  // The long-form `webClient.method(HttpMethod.GET).uri("/x")` chain
  // uses an extra navigation hop and an enum field access — handled
  // by `WEB_CLIENT_LONG_PATTERNS` below, separately so each query is
  // straightforward to reason about.
  const WEB_CLIENT_SHORT_PATTERNS = compilePatterns({
    name: 'kotlin-web-client-short',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (call_expression
            (navigation_expression
              (call_expression
                (navigation_expression
                  (simple_identifier) @obj (#eq? @obj "webClient")
                  (navigation_suffix
                    (simple_identifier) @verb (#match? @verb "^(get|post|put|delete|patch)$")))
                (call_suffix (value_arguments)))
              (navigation_suffix (simple_identifier) @uri (#eq? @uri "uri")))
            (call_suffix
              (value_arguments . (value_argument . (string_literal) @path))))
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer: Spring WebClient (long form) ───────────────────────────
  // The fluent long form passes the verb as a `HttpMethod.X` enum field
  // access through `.method(...)`, then carries the path on a separate
  // `.uri(...)` hop further down the chain:
  //
  //   webClient.method(HttpMethod.GET).uri("/x").retrieve().awaitBody<T>()
  //
  // Compared to the short form there are two extra structural hops:
  //   - the inner `.method(...)` `call_expression` has a `value_argument`
  //     whose payload is itself a `navigation_expression` (HttpMethod → .GET)
  //   - the outer `.uri(...)` is reached via one more
  //     `navigation_expression` wrapping that inner call
  //
  // We capture the verb at the `simple_identifier` under `HttpMethod`'s
  // `navigation_suffix`. That `simple_identifier` is the literal field
  // name (`GET`, `POST`, ...) used in source — Kotlin enum fields by
  // convention are upper-case, matching `HttpMethod` from
  // `org.springframework.http`. We forward the captured text as-is.
  //
  // Variable-bound verbs (`val verb = HttpMethod.PATCH; webClient.method(verb)...`)
  // do NOT match — they fail the `(navigation_expression ...)` shape
  // because the value_argument carries a bare `simple_identifier` instead
  // of a `HttpMethod.X` field access. This is intentional: source-scan
  // can't follow the binding without graph context. Pinned by an
  // anti-overreach test in the consumer suite.
  const WEB_CLIENT_LONG_PATTERNS = compilePatterns({
    name: 'kotlin-web-client-long',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (call_expression
            (navigation_expression
              (call_expression
                (navigation_expression
                  (simple_identifier) @obj (#eq? @obj "webClient")
                  (navigation_suffix
                    (simple_identifier) @method_call (#eq? @method_call "method")))
                (call_suffix
                  (value_arguments
                    . (value_argument
                        (navigation_expression
                          (simple_identifier) @httpMethodCls (#eq? @httpMethodCls "HttpMethod")
                          (navigation_suffix (simple_identifier) @verb))))))
              (navigation_suffix (simple_identifier) @uri (#eq? @uri "uri")))
            (call_suffix
              (value_arguments . (value_argument . (string_literal) @path))))
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer: OkHttp Request.Builder().url("/x") ─────────────────────
  // Kotlin parses `Request.Builder()` as a `call_expression` whose
  // callee is a `navigation_expression` (Request → .Builder), NOT as
  // Java's `object_creation_expression`. The chain `.url("/x")` then
  // wraps that in another `call_expression`. The query mirrors Java's
  // `OK_HTTP_PATTERNS` (java.ts) but adapts the node types.
  //
  // Receiver `Request` is constrained by name (#eq? @cls); a project
  // that imports OkHttp's `Request` under an alias (`import okhttp3.Request as OkRequest`)
  // would not be picked up — this matches the Java plugin's heuristic.
  //
  // **Known limitation — verb defaults to GET.** OkHttp encodes the
  // verb on a *sibling* call further down the builder chain (e.g.
  // `.post(body)` / `.get()` / `.delete()`), not on `.url(...)` itself.
  // This query intentionally does not walk the chain to recover the
  // verb — it emits `method: 'GET'` for every match, mirroring
  // `java.ts:OK_HTTP_PATTERNS`. So a `Request.Builder().url("/x").post(body).build()`
  // call becomes `http::GET::/x`, not `http::POST::/x`. This is the
  // same trade-off Java has accepted; pinned by an anti-overreach
  // test in `http-route-extractor.test.ts` so a future verb-walk
  // implementation has to update this comment in lockstep.
  const OK_HTTP_PATTERNS = compilePatterns({
    name: 'kotlin-okhttp',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (call_expression
            (navigation_expression
              (call_expression
                (navigation_expression
                  (simple_identifier) @cls (#eq? @cls "Request")
                  (navigation_suffix (simple_identifier) @builder (#eq? @builder "Builder")))
                (call_suffix (value_arguments)))
              (navigation_suffix (simple_identifier) @method (#eq? @method "url")))
            (call_suffix
              (value_arguments . (value_argument . (string_literal) @path))))
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  /**
   * Find the nearest enclosing class_declaration ancestor for a node, or
   * null if the node is top-level. Mirrors the Java plugin's helper.
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
   * Join a class-level prefix and a method-level path. Identical
   * semantics to the Java plugin: strip leading/trailing slashes on
   * the prefix, strip leading slashes on the method path, ensure a
   * single slash between them.
   */
  function joinPath(prefix: string, methodPath: string): string {
    const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
    const cleanSub = methodPath.replace(/^\/+/, '');
    if (!cleanPrefix) return `/${cleanSub}`;
    return `/${cleanPrefix}/${cleanSub}`;
  }

  return {
    name: 'kotlin-http',
    language,
    scan(tree) {
      const out: HttpDetection[] = [];

      // ─── Class prefixes ─────────────────────────────────────────────
      const prefixByClassId = new Map<number, string>();
      for (const match of runCompiledPatterns(SPRING_CLASS_PREFIX_PATTERNS, tree)) {
        const prefixNode = match.captures.prefix;
        const classNode = match.captures.class;
        if (!prefixNode || !classNode) continue;
        const prefix = unquoteLiteral(prefixNode.text);
        if (prefix !== null) prefixByClassId.set(classNode.id, prefix);
      }

      // ─── Method routes ──────────────────────────────────────────────
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

      // ─── Consumers: WebClient short form (.get()/.post()/etc → .uri) ─
      for (const match of runCompiledPatterns(WEB_CLIENT_SHORT_PATTERNS, tree)) {
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

      // ─── Consumers: WebClient long form (.method(HttpMethod.X) → .uri) ─
      for (const match of runCompiledPatterns(WEB_CLIENT_LONG_PATTERNS, tree)) {
        const verbNode = match.captures.verb;
        const pathNode = match.captures.path;
        if (!verbNode || !pathNode) continue;
        // The captured text is the literal `HttpMethod.X` field name.
        // Spring's `org.springframework.http.HttpMethod` defines GET,
        // POST, PUT, DELETE, PATCH, HEAD, OPTIONS, TRACE — we only
        // emit for the five verbs we already handle elsewhere, so
        // exotic ones are silently skipped (consistent with the
        // short form's WEB_CLIENT_SHORT_TO_HTTP guard). The accepted
        // verb regex is hoisted to module scope (see
        // `WEB_CLIENT_LONG_VERB_RE` near the top of this file).
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
}

/**
 * The exported plugin is `null` when tree-sitter-kotlin's native
 * binding is unavailable. `http-patterns/index.ts` checks for null
 * before registering `.kt`/`.kts` so missing optional grammars never
 * crash the orchestrator.
 */
export const KOTLIN_HTTP_PLUGIN: HttpLanguagePlugin | null = Kotlin
  ? buildKotlinPlugin(Kotlin)
  : null;
