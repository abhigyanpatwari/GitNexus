import type Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../../tree-sitter/vendored-grammars.js';
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
import {
  METHOD_ANNOTATION_TO_HTTP,
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
 * tree-sitter-kotlin is a vendored grammar loaded from `vendor/` by absolute
 * path (NEVER copied into node_modules — see vendored-grammars.ts / #2111) —
 * when its native binding is unavailable the plugin gracefully exports `null`
 * and `http-patterns/index.ts` skips registration for `.kt`/`.kts` files.
 */

/** Loaded lazily; null when the grammar binding isn't available. */
let Kotlin: unknown | null = null;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  Kotlin = null;
}

// The Spring `@(Get|...)Mapping` verb map, RestTemplate / WebClient short-form
// verb maps, the `@(Get|...)Exchange` verb map, `joinPath`, `parseRequestLine`,
// and the shared confidence/framework constants are imported from
// `spring-consumer-shared.ts` / `spring-shared.ts` so the Kotlin and Java
// plugins emit identical contract IDs.

// The WebClient long-form verb gate (`WEB_CLIENT_LONG_VERB_RE`) is imported from
// `spring-consumer-shared.ts` so the Java and Kotlin long-form scans accept the
// same verb set (HEAD/OPTIONS/TRACE excluded, matching the short form).

// The de-duping prefix accumulator (`pushPrefix`) is imported from
// `spring-consumer-shared.ts` so the Java and Kotlin plugins build their
// per-declaration prefix maps identically.

/**
 * Tree-sitter sub-pattern for the Kotlin `arrayOf("/a", "/b")` annotation-array
 * form, capturing each element string under `cap` (`@prefix` or `@path`).
 *
 * Kept as a DEDICATED query fragment embedded in its own pattern — NEVER as an
 * arm of the `[(string_literal) (collection_literal …)]` alternation. The
 * `#eq? @arrayOf "arrayOf"` predicate, sharing a single alternation bucket with
 * the string/collection arms, would evaluate FALSE for those arms (where
 * `@arrayOf` is absent) and silently drop them — the tree-sitter 0.21.x hazard
 * documented in `java.ts`. tree-sitter yields one match per `arrayOf` element,
 * so multi-element arrays accumulate through the same loops as `collection_literal`
 * (verified by AST probe). The `arrayOf` callee constraint keeps unrelated calls
 * (`buildPath("/x")`) from matching.
 */
const arrayOfArg = (cap: string): string => `(call_expression
  (simple_identifier) @arrayOf (#eq? @arrayOf "arrayOf")
  (call_suffix (value_arguments (value_argument (string_literal) ${cap}))))`;

// ─── Kotlin OkHttp builder verb-walk (parity with java-static-path.ts) ──
// Mirrors `inferOkHttpMethod`, adapted to the Kotlin grammar: a call `X.name(args)`
// is a `call_expression` whose callee is a `navigation_expression` (receiver +
// `navigation_suffix` → the method name) and whose `call_suffix` holds the
// `value_arguments`. The chain is left-nested via `navigation_expression`, so we
// walk UP from the matched `.url(...)` call to the sibling verb call (`.post()` /
// `.method("X")`), exactly as the Java side does — so `.java` and `.kt` infer the
// same verb for the same OkHttp shape.
const OK_HTTP_VERB_HELPERS = ['get', 'head', 'post', 'put', 'delete', 'patch'];

/** The method name a Kotlin `call_expression` invokes (its `navigation_suffix`). */
function kotlinCallName(call: Parser.SyntaxNode): string | null {
  const callee = call.namedChild(0);
  if (callee?.type !== 'navigation_expression') return null;
  for (let i = 0; i < callee.namedChildCount; i++) {
    const child = callee.namedChild(i);
    if (child?.type === 'navigation_suffix') return child.namedChild(0)?.text ?? null;
  }
  return null;
}

/** The first string-literal argument of a Kotlin `call_expression`, else null. */
function kotlinFirstStringArg(call: Parser.SyntaxNode): string | null {
  for (let i = 0; i < call.namedChildCount; i++) {
    const callSuffix = call.namedChild(i);
    if (callSuffix?.type !== 'call_suffix') continue;
    for (let j = 0; j < callSuffix.namedChildCount; j++) {
      const args = callSuffix.namedChild(j);
      if (args?.type !== 'value_arguments') continue;
      const firstArg = args.namedChild(0);
      if (firstArg?.type !== 'value_argument') return null;
      // Positional literal `"X"`, or named-argument `name = "X"` (the label is a
      // leading `simple_identifier` and the literal follows). A non-literal value
      // (a variable) → null → unresolvable.
      const positional = firstArg.namedChild(0);
      if (positional?.type === 'string_literal') return unquoteLiteral(positional.text);
      const labeled = positional?.type === 'simple_identifier' ? firstArg.namedChild(1) : null;
      return labeled?.type === 'string_literal' ? unquoteLiteral(labeled.text) : null;
    }
  }
  return null;
}

/** The receiver expression a Kotlin `call_expression` is invoked on. */
function kotlinReceiver(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const nav = call.namedChild(0);
  return nav?.type === 'navigation_expression' ? nav.namedChild(0) : null;
}

/** The call that invokes a method ON `call` as its receiver — one hop up the chain. */
function kotlinChainParentCall(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const nav = call.parent;
  if (nav?.type !== 'navigation_expression' || nav.namedChild(0)?.id !== call.id) return null;
  return nav.parent?.type === 'call_expression' ? nav.parent : null;
}

/** Every `call_expression` in the fluent chain `pathCall` belongs to, innermost
 *  (next to the construction) → outermost. Lets the verb-walk find a verb call
 *  wherever it sits relative to `.url(...)` — parity with java-static-path.ts
 *  `builderChainCalls`. */
function kotlinBuilderChainCalls(pathCall: Parser.SyntaxNode): Parser.SyntaxNode[] {
  let innermost = pathCall;
  let recv = kotlinReceiver(innermost);
  while (recv?.type === 'call_expression') {
    innermost = recv;
    recv = kotlinReceiver(innermost);
  }
  const calls: Parser.SyntaxNode[] = [innermost];
  let cur = innermost;
  for (let next = kotlinChainParentCall(cur); next; next = kotlinChainParentCall(cur)) {
    calls.push(next);
    cur = next;
  }
  return calls;
}

/** True when `urlCall`'s receiver chain bottoms out on `Request.Builder()` — the
 *  Kotlin anti-overreach gate (mirror of okHttpUrlRootsAtBuilder), so a `.url(...)`
 *  on an unrelated object is rejected while a builder call before `.url()` is kept. */
function kotlinUrlRootsAtRequestBuilder(urlCall: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = kotlinReceiver(urlCall);
  while (cur?.type === 'call_expression') {
    const recv = kotlinReceiver(cur);
    if (recv?.type === 'simple_identifier')
      return recv.text === 'Request' && kotlinCallName(cur) === 'Builder';
    cur = recv;
  }
  return false;
}

/** Infer the OkHttp verb by scanning the builder chain around the matched
 *  `.url(...)` call — parity with java-static-path.ts `inferOkHttpMethod`. The
 *  LAST verb call wins (runtime overwrite); `null` for an unresolvable
 *  `.method(verb)` (non-literal/empty) so the caller skips; `'GET'` when the
 *  chain has no verb call. */
function inferKotlinOkHttpMethod(urlCall: Parser.SyntaxNode): string | null {
  let lastVerbCall: Parser.SyntaxNode | null = null;
  for (const call of kotlinBuilderChainCalls(urlCall)) {
    if (call.id === urlCall.id) continue;
    const name = kotlinCallName(call);
    if (name === 'method' || (name !== null && OK_HTTP_VERB_HELPERS.includes(name)))
      lastVerbCall = call;
  }
  if (lastVerbCall === null) return 'GET'; // no verb call → OkHttp default
  const name = kotlinCallName(lastVerbCall);
  if (name === 'method') {
    const verb = kotlinFirstStringArg(lastVerbCall);
    return verb ? verb.toUpperCase() : null;
  }
  return name === null ? 'GET' : name.toUpperCase();
}

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
                    (value_argument . [(string_literal) @prefix (collection_literal (string_literal) @prefix)])))))
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
                      [(string_literal) @prefix (collection_literal (string_literal) @prefix)])))))
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
                    (value_argument . ${arrayOfArg('@prefix')})))))
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
                      ${arrayOfArg('@prefix')})))))
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
                    (value_argument . [(string_literal) @path (collection_literal (string_literal) @path)])))))
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
                      [(string_literal) @path (collection_literal (string_literal) @path)])))))
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
                    (value_argument . ${arrayOfArg('@path')})))))
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
                      ${arrayOfArg('@path')})))))
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
  // Full parity with the Java OkHttp extraction (java.ts + java-static-path.ts),
  // adapted to the Kotlin grammar (a call is a `call_expression` whose callee is a
  // `navigation_expression`, not Java's `object_creation_expression`):
  //
  //   • Match a bare `.url("literal")` call on ANY receiver (capture it as `@call`);
  //     `kotlinUrlRootsAtRequestBuilder` (JS) then verifies the receiver chain
  //     bottoms out on `Request.Builder()` — re-imposing the framework anchor while
  //     allowing a builder call BEFORE `.url()` (`Request.Builder().addHeader(...)`
  //     `.url(...)`) and rejecting a `.url(...)` on an unrelated object.
  //   • `inferKotlinOkHttpMethod` scans the whole chain for the verb (`.post(body)`
  //     / `.get()` / `.method("X")`, before or after `.url()`) — the mirror of
  //     `inferOkHttpMethod`. So `Request.Builder().url("/x").post(body).build()`
  //     becomes `http::POST::/x` on both `.java` and `.kt` (pinned by the Java↔Kotlin
  //     parity harness). A variable-bound/empty `.method(verb)` is unresolvable →
  //     the call is skipped (not a guessed GET), matching the Java side.
  //
  // Receiver `Request` is constrained by name (in the JS gate); a project that
  // imports OkHttp's `Request` under an alias would not be picked up — matching the
  // Java plugin's heuristic.
  const OK_HTTP_PATTERNS = compilePatterns({
    name: 'kotlin-okhttp',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (call_expression
            (navigation_expression
              (navigation_suffix (simple_identifier) @method (#eq? @method "url")))
            (call_suffix
              (value_arguments . (value_argument . (string_literal) @path)))) @call
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer (OpenFeign): @FeignClient interface marker + path prefix ─
  // A `@FeignClient` interface's `@(Get|...)Mapping` methods describe OUTBOUND
  // calls (consumers), not routes the service serves. Pattern 1 marks the
  // interface; pattern 2 captures its optional `path = "/prefix"` (the
  // `name`/`value`/`url` attributes identify the remote service, not a path).
  // In tree-sitter-kotlin an `interface` is a `class_declaration`, so the
  // method-route loop reclassifies @*Mapping methods whose enclosing
  // class_declaration is in `feignClassIds` (see scan()).
  const SPRING_FEIGN_CLIENT_PATTERNS = compilePatterns({
    name: 'kotlin-spring-feign-client',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "FeignClient")))))) @class
        `,
      },
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "FeignClient"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#eq? @key "path")
                      [(string_literal) @prefix (collection_literal (string_literal) @prefix)])))))) @class
        `,
      },
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "FeignClient"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#eq? @key "path")
                      ${arrayOfArg('@prefix')})))))) @class
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer: Spring 6 HTTP Interface @(Get|...)Exchange ─────────────
  // Declarative client interfaces proxied by HttpServiceProxyFactory (over
  // RestClient / WebClient / RestTemplate). The path lives in `url`/`value`
  // (named) or positionally. Always a consumer — no provider ambiguity.
  const SPRING_EXCHANGE_PATTERNS = compilePatterns({
    name: 'kotlin-spring-http-exchange',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (function_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Exchange$"))
                  (value_arguments
                    (value_argument . [(string_literal) @path (collection_literal (string_literal) @path)])))))
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
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Exchange$"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(url|value)$")
                      [(string_literal) @path (collection_literal (string_literal) @path)])))))
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
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Exchange$"))
                  (value_arguments
                    (value_argument . ${arrayOfArg('@path')})))))
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
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Exchange$"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(url|value)$")
                      ${arrayOfArg('@path')})))))
            (simple_identifier) @method_name) @method
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer: HTTP Interface type-level @HttpExchange(url) prefix ─────
  const SPRING_HTTP_EXCHANGE_CLASS_PATTERNS = compilePatterns({
    name: 'kotlin-spring-http-exchange-class',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "HttpExchange"))
                  (value_arguments
                    (value_argument . [(string_literal) @prefix (collection_literal (string_literal) @prefix)])))))) @class
        `,
      },
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "HttpExchange"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(url|value)$")
                      [(string_literal) @prefix (collection_literal (string_literal) @prefix)])))))) @class
        `,
      },
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "HttpExchange"))
                  (value_arguments
                    (value_argument . ${arrayOfArg('@prefix')})))))) @class
        `,
      },
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "HttpExchange"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(url|value)$")
                      ${arrayOfArg('@prefix')})))))) @class
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Consumer: OpenFeign native @RequestLine("VERB /path") ────────────
  // Two patterns mirror the positional vs named split. java.ts accepts the
  // named `value` argument (java.ts:442 drops any non-`value` key); the
  // positional pattern's `.` anchor only matches when the string literal is the
  // first argument, so the named form needs its own pattern. Constraining
  // `#eq? @key "value"` keeps non-`value` keys (`name`, etc.) dropped — Java
  // parity, just enforced in the query rather than the JS loop.
  const SPRING_REQUEST_LINE_PATTERNS = compilePatterns({
    name: 'kotlin-spring-request-line',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (function_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "RequestLine"))
                  (value_arguments
                    (value_argument . (string_literal) @value)))))
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
                  (user_type (type_identifier) @ann (#eq? @ann "RequestLine"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#eq? @key "value")
                      (string_literal) @value)))))
            (simple_identifier) @method_name) @method
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Provider via interface inheritance (Spring interface-based controller) ─
  // Pattern: `@RestController class X(...) : XApi` where the route annotations
  // live on the `XApi` interface and the controller's `override fun` carries
  // none. Java resolves this in `scanProject` (scanSpringProject); this is the
  // Kotlin port. tree-sitter-kotlin models BOTH class and interface as
  // `class_declaration`; the `interface` keyword token distinguishes them.
  const KOTLIN_TYPE_DECLARATION_PATTERNS = compilePatterns({
    name: 'kotlin-type-declaration',
    language,
    patterns: [{ meta: {}, query: `(class_declaration (type_identifier) @name) @type` }],
  } satisfies LanguagePatterns<Record<string, never>>);

  /** A `class_declaration` is an interface when it carries the `interface` keyword token. */
  const isKotlinInterface = (node: Parser.SyntaxNode): boolean =>
    node.children.some((c) => c.type === 'interface');

  /** Resolve an `annotation` node's simple name: `@Foo` / `@Foo(...)` / `@a.b.Foo` → "Foo". */
  const kotlinAnnotationName = (annotation: Parser.SyntaxNode): string | null => {
    const direct = annotation.namedChildren.find((c) => c.type === 'user_type');
    const ctor = annotation.namedChildren.find((c) => c.type === 'constructor_invocation');
    const userType = direct ?? ctor?.namedChildren.find((c) => c.type === 'user_type');
    // A fully-qualified annotation (`@a.b.Foo`) parses to a `user_type` carrying
    // one `type_identifier` per dotted segment (`a`, `b`, `Foo`); the trailing
    // one is the simple name. Taking the FIRST would resolve `@org…RestController`
    // to "org" and miss the controller.
    const idents = userType?.namedChildren.filter((c) => c.type === 'type_identifier') ?? [];
    const ident = idents.at(-1);
    return ident ? ident.text : null;
  };

  /**
   * Whether a `class_declaration` is a Spring `@RestController` / `@Controller`.
   * All forms attach under `modifiers` as an `annotation` (confirmed against
   * tree-sitter-kotlin fwcd): the bare `@RestController`, the common
   * `@RestController @RequestMapping("/x")` pair, AND the arg-form
   * `@RestController("beanName")` — the last parses to an `annotation` whose
   * child is a `constructor_invocation` (NOT a detached sibling), which
   * `kotlinAnnotationName` reads. A single pass over `modifiers` covers them all.
   */
  const CONTROLLER_ANNOTATIONS = new Set(['RestController', 'Controller']);
  const kotlinClassIsController = (typeNode: Parser.SyntaxNode): boolean => {
    const modifiers = typeNode.namedChildren.find((c) => c.type === 'modifiers');
    for (const ann of modifiers?.namedChildren ?? []) {
      if (ann.type !== 'annotation') continue;
      const name = kotlinAnnotationName(ann);
      if (name && CONTROLLER_ANNOTATIONS.has(name)) return true;
    }
    return false;
  };

  /** Supertype names from `: A, B` (`delegation_specifier` → `user_type` → `type_identifier`). */
  const collectKotlinSupertypes = (node: Parser.SyntaxNode): string[] => {
    const out: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type !== 'delegation_specifier') continue;
      const userType = child.namedChildren.find((c) => c.type === 'user_type');
      // FQN supertype (`: a.b.Api`) → one `type_identifier` per segment; the
      // trailing one is the simple name (taking the first would yield "a").
      const idents = userType?.namedChildren.filter((c) => c.type === 'type_identifier') ?? [];
      const ident = idents.at(-1);
      if (ident) out.push(ident.text);
    }
    return out;
  };

  /** Direct `function_declaration` members of a type (no descent into nested types). */
  const collectKotlinDirectMethods = (typeNode: Parser.SyntaxNode): Parser.SyntaxNode[] => {
    const body = typeNode.namedChildren.find((c) => c.type === 'class_body');
    if (!body) return [];
    return body.namedChildren.filter((c) => c.type === 'function_declaration');
  };

  const kotlinFunctionName = (fn: Parser.SyntaxNode): string | null =>
    fn.namedChildren.find((c) => c.type === 'simple_identifier')?.text ?? null;

  const collectKotlinSpringTypes = (filePath: string, tree: Parser.Tree): SharedSpringType[] => {
    // Class-level @RequestMapping prefixes (reuse the provider class-prefix query).
    const prefixByClassId = new Map<number, string[]>();
    for (const match of runCompiledPatterns(SPRING_CLASS_PREFIX_PATTERNS, tree)) {
      const prefixNode = match.captures.prefix;
      const classNode = match.captures.class;
      if (!prefixNode || !classNode) continue;
      const prefix = unquoteLiteral(prefixNode.text);
      if (prefix !== null) pushPrefix(prefixByClassId, classNode.id, prefix);
    }
    // Method @(Get|...)Mapping routes keyed by the function_declaration node id.
    const routesByMethodId = new Map<number, Array<{ method: string; path: string }>>();
    for (const match of runCompiledPatterns(SPRING_METHOD_ROUTE_PATTERNS, tree)) {
      const annNode = match.captures.ann;
      const pathNode = match.captures.path;
      const methodNode = match.captures.method;
      if (!annNode || !pathNode || !methodNode) continue;
      const httpMethod = METHOD_ANNOTATION_TO_HTTP[annNode.text];
      if (!httpMethod) continue;
      const rawPath = unquoteLiteral(pathNode.text);
      if (rawPath === null) continue;
      const arr = routesByMethodId.get(methodNode.id) ?? [];
      arr.push({ method: httpMethod, path: rawPath });
      routesByMethodId.set(methodNode.id, arr);
    }

    const out: SharedSpringType[] = [];
    for (const match of runCompiledPatterns(KOTLIN_TYPE_DECLARATION_PATTERNS, tree)) {
      const typeNode = match.captures.type;
      const nameNode = match.captures.name;
      if (!typeNode || !nameNode) continue;
      const kind = isKotlinInterface(typeNode) ? 'interface' : 'class';
      const methods = collectKotlinDirectMethods(typeNode)
        .map((fn) => ({ name: kotlinFunctionName(fn), routes: routesByMethodId.get(fn.id) ?? [] }))
        .filter((m): m is { name: string; routes: Array<{ method: string; path: string }> } => {
          return m.name !== null;
        });
      out.push({
        filePath,
        kind,
        name: nameNode.text,
        isController: kind === 'class' ? kotlinClassIsController(typeNode) : false,
        classPrefixes: prefixByClassId.get(typeNode.id) ?? [],
        implementedInterfaces: kind === 'class' ? collectKotlinSupertypes(typeNode) : [],
        methods,
      });
    }
    return out;
  };

  // The interface-based-controller inheritance algorithm is shared with java.ts
  // (`scanSpringInheritanceProject`); this collects the language-specific
  // `SharedSpringType` view and delegates. kotlinClassIsController handles every
  // controller form (bare, paired, and the arg-form `@RestController("bean")`)
  // via the `modifiers` `annotation`/`constructor_invocation` shape.
  const scanKotlinProject = (files: readonly HttpScanInput[]): HttpFileDetections[] =>
    scanSpringInheritanceProject(
      files.flatMap((f) => collectKotlinSpringTypes(f.filePath, f.tree)),
    );

  return {
    name: 'kotlin-http',
    language,
    scan(tree) {
      const out: HttpDetection[] = [];

      // ─── Class prefixes ─────────────────────────────────────────────
      const prefixByClassId = new Map<number, string[]>();
      for (const match of runCompiledPatterns(SPRING_CLASS_PREFIX_PATTERNS, tree)) {
        const prefixNode = match.captures.prefix;
        const classNode = match.captures.class;
        if (!prefixNode || !classNode) continue;
        const prefix = unquoteLiteral(prefixNode.text);
        if (prefix !== null) pushPrefix(prefixByClassId, classNode.id, prefix);
      }

      // ─── OpenFeign client interfaces + HTTP Interface type prefixes ──
      // In tree-sitter-kotlin an `interface` is a `class_declaration`, so a
      // `@FeignClient` interface's @(Get|...)Mapping methods would otherwise be
      // mis-emitted as providers. Collect the FeignClient class ids (and their
      // optional `path` prefix) so the method-route loop can reclassify them.
      const feignClassIds = new Set<number>();
      const feignPrefixByClassId = new Map<number, string[]>();
      for (const match of runCompiledPatterns(SPRING_FEIGN_CLIENT_PATTERNS, tree)) {
        const classNode = match.captures.class;
        if (!classNode) continue;
        feignClassIds.add(classNode.id);
        const prefixNode = match.captures.prefix;
        if (prefixNode) {
          const prefix = unquoteLiteral(prefixNode.text);
          if (prefix !== null) pushPrefix(feignPrefixByClassId, classNode.id, prefix);
        }
      }
      const httpExchangePrefixByClassId = new Map<number, string[]>();
      for (const match of runCompiledPatterns(SPRING_HTTP_EXCHANGE_CLASS_PATTERNS, tree)) {
        const classNode = match.captures.class;
        const prefixNode = match.captures.prefix;
        if (!classNode || !prefixNode) continue;
        const prefix = unquoteLiteral(prefixNode.text);
        if (prefix !== null) pushPrefix(httpExchangePrefixByClassId, classNode.id, prefix);
      }

      // ─── Method routes (Spring providers) + OpenFeign consumers ─────
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
        // A @(Get|...)Mapping inside a @FeignClient interface is an OpenFeign
        // consumer (a remote call), not a route this service serves.
        if (enclosingClass && feignClassIds.has(enclosingClass.id)) {
          // @FeignClient(path) wins over @RequestMapping; a multi-element prefix
          // yields one consumer per (prefix × this route).
          const prefixes = feignPrefixByClassId.get(enclosingClass.id) ??
            prefixByClassId.get(enclosingClass.id) ?? [''];
          for (const prefix of prefixes) {
            out.push({
              role: 'consumer',
              framework: OPENFEIGN_FRAMEWORK,
              method: httpMethod,
              path: joinPath(prefix, rawPath),
              name: nameNode?.text ?? null,
              line: methodNode.startPosition.row + 1,
              confidence: FEIGN_CONFIDENCE,
            });
          }
          continue;
        }
        // A @(Get|...)Mapping on a (non-Feign) interface declares a route
        // *contract*, not a route this service serves — the implementing
        // @RestController is the provider, emitted via scanProject's interface
        // inheritance. Java drops these implicitly (findEnclosingClass returns
        // null for an interface_declaration); tree-sitter-kotlin models an
        // interface as a class_declaration, so skip it explicitly here.
        if (enclosingClass && isKotlinInterface(enclosingClass)) continue;
        // A multi-element class `@RequestMapping(["/a","/b"])` registers the method
        // under each prefix — emit one provider per (prefix × this route).
        const prefixes = enclosingClass ? (prefixByClassId.get(enclosingClass.id) ?? ['']) : [''];
        for (const prefix of prefixes) {
          out.push({
            role: 'provider',
            framework: 'spring',
            method: httpMethod,
            path: joinPath(prefix, rawPath),
            name: nameNode?.text ?? null,
            // Spring providers are named controller methods resolved BY NAME, so
            // `line` is inert — a named provider never falls through to line-span
            // containment. Gate it on a present name so a (grammar-impossible)
            // nameless provider degrades to file-level rather than resolving by
            // containment to the enclosing class. Wired for consumer-emit parity
            // and a future inline DSL.
            line: nameNode?.text ? methodNode.startPosition.row + 1 : undefined,
            confidence: 0.8,
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
        const path = unquoteLiteral(pathNode.text);
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
          line: pathNode.startPosition.row + 1,
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
          line: pathNode.startPosition.row + 1,
          confidence: 0.7,
        });
      }

      // ─── Consumers: OkHttp Request.Builder().url("path") ────────────
      // Gate to chains rooting at `Request.Builder()` (so a call before `.url()` is
      // captured but an unrelated `.url()` is not), then recover the verb by scanning
      // the chain (parity with Java); a variable-bound or empty `.method(verb)` is
      // unresolvable → emit nothing rather than a GET.
      for (const match of runCompiledPatterns(OK_HTTP_PATTERNS, tree)) {
        const callNode = match.captures.call;
        const pathNode = match.captures.path;
        if (!callNode || !pathNode) continue;
        if (!kotlinUrlRootsAtRequestBuilder(callNode)) continue;
        const path = unquoteLiteral(pathNode.text);
        if (path === null) continue;
        const method = inferKotlinOkHttpMethod(callNode);
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

      // ─── Consumers: Spring HTTP Interface @(Get|...)Exchange ────────
      for (const match of runCompiledPatterns(SPRING_EXCHANGE_PATTERNS, tree)) {
        const annNode = match.captures.ann;
        const pathNode = match.captures.path;
        const nameNode = match.captures.method_name;
        const methodNode = match.captures.method;
        if (!annNode || !pathNode || !methodNode) continue;
        const httpMethod = EXCHANGE_ANNOTATION_TO_HTTP[annNode.text];
        if (!httpMethod) continue;
        const rawPath = unquoteLiteral(pathNode.text);
        if (rawPath === null) continue;
        const enclosingClass = findEnclosingClass(methodNode);
        const prefixes = enclosingClass
          ? (httpExchangePrefixByClassId.get(enclosingClass.id) ?? [''])
          : [''];
        for (const prefix of prefixes) {
          out.push({
            role: 'consumer',
            framework: HTTP_INTERFACE_FRAMEWORK,
            method: httpMethod,
            path: joinPath(prefix, rawPath),
            name: nameNode?.text ?? null,
            line: methodNode.startPosition.row + 1,
            confidence: EXCHANGE_CONFIDENCE,
          });
        }
      }

      // ─── Consumers: OpenFeign native @RequestLine("VERB /path") ─────
      // Method-level only and always declared on an interface — Feign builds its
      // proxy from the interface, so a `@RequestLine` on a concrete class is not
      // a client call. We do NOT require an enclosing `@FeignClient` (core Feign
      // uses `@RequestLine` with `Feign.builder()`, not Spring Cloud's
      // `@FeignClient`); the `RequestLine` name plus the structural interface
      // check keep false positives away. Mirrors java.ts's `findEnclosingInterface`
      // gate — in tree-sitter-kotlin an interface is a `class_declaration`, so we
      // test the `interface` keyword via isKotlinInterface.
      for (const match of runCompiledPatterns(SPRING_REQUEST_LINE_PATTERNS, tree)) {
        const valueNode = match.captures.value;
        const nameNode = match.captures.method_name;
        const methodNode = match.captures.method;
        if (!valueNode || !methodNode) continue;
        const raw = unquoteLiteral(valueNode.text);
        const parsed = raw !== null ? parseRequestLine(raw) : null;
        if (!parsed) continue;
        const enclosingClass = findEnclosingClass(methodNode);
        if (!enclosingClass || !isKotlinInterface(enclosingClass)) continue;
        // Mirror java.ts (which pre-merges the @RequestMapping fallback into
        // feignPrefixByInterfaceId, "path wins"): @FeignClient(path) wins, else
        // the interface's class-level @RequestMapping prefix, else none. Without
        // the prefixByClassId fallback Kotlin dropped the class prefix that Java
        // applies — the same fallback chain the @GetMapping-in-Feign path uses above.
        const prefixes = feignPrefixByClassId.get(enclosingClass.id) ??
          prefixByClassId.get(enclosingClass.id) ?? [''];
        for (const prefix of prefixes) {
          out.push({
            role: 'consumer',
            framework: OPENFEIGN_FRAMEWORK,
            method: parsed.method,
            path: joinPath(prefix, parsed.path),
            name: nameNode?.text ?? null,
            confidence: REQUEST_LINE_CONFIDENCE,
          });
        }
      }

      return out;
    },
    scanProject: scanKotlinProject,
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
