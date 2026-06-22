import Parser from 'tree-sitter';
import { unquoteLiteral } from '../tree-sitter-scanner.js';

// ─── Statically-resolvable consumer path + builder verb-walk helpers ──────
// RestTemplate calls increasingly pass a non-literal path argument that is
// still statically derivable — `URI.create("/x")` or a `UriComponentsBuilder`
// fluent chain. These helpers resolve those shapes to a literal path; a
// genuinely dynamic argument (a variable, a non-`URI`/`UriComponentsBuilder`
// call) resolves to null and the call site is skipped. This module also owns
// the OkHttp / Java-HttpClient builder verb-walks (`inferOkHttpMethod` /
// `inferHttpClientMethod`), which recover the request verb by walking UP the
// fluent chain from the matched `.url(...)` / `.uri(...)` call. Extracted from
// java.ts (#2268) so that plugin stays under ~1000 lines; the `methodInvocation*`
// primitives + `firstLiteralArgument` are module-internal (shared by the path
// resolvers and the verb-walks), while the path resolver and the two verb-walks
// are java.ts's only entry points here.

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

/** Resolve a `URI.create("/path")` call to its literal path; null otherwise. */
function extractUriCreatePath(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'method_invocation') return null;
  if (methodInvocationObject(node)?.text !== 'URI' || methodInvocationName(node) !== 'create')
    return null;
  return firstLiteralArgument(node);
}

// Join a builder base with a sub-path using exactly one separating slash. This
// is intentionally NOT the shared `joinPath`: `joinPath` force-prepends `/`,
// whereas `appendPath` must preserve an absolute/host base (`fromHttpUrl`
// "https://host/api") so the host survives until `normalizeConsumerPath` strips
// it downstream. Do not unify the two.
function appendPath(base: string, subPath: string): string {
  if (!base) return subPath.startsWith('/') ? subPath : `/${subPath}`;
  if (!subPath) return base;
  return `${base.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}`;
}

/**
 * Resolve a `UriComponentsBuilder` fluent chain to its literal path. Seed
 * methods (`fromPath`/`fromUriString`/`fromHttpUrl`) return the literal arg
 * VERBATIM — a `fromHttpUrl("https://host/api")` seed keeps its host, which the
 * shared `normalizeConsumerPath` later reduces to the path (the same single
 * normalization point every other consumer path goes through). `path` and
 * `pathSegment` append literal segments; `build`/`toUriString`/`toUri`/`encode`
 * and the `query*` family pass through (query attributes do not change the
 * path). Any non-literal segment or unknown call → null.
 */
// A UriComponentsBuilder chain deeper than this is not realistic source; cap the
// recursion so a pathological / machine-generated chain returns null instead of
// overflowing the stack (mirrors the project's other AST-depth guards).
const MAX_BUILDER_DEPTH = 100;

function extractUriComponentsBuilderPath(node: Parser.SyntaxNode, depth = 0): string | null {
  if (depth > MAX_BUILDER_DEPTH) return null;
  if (node.type !== 'method_invocation') return null;
  const name = methodInvocationName(node);
  const objectNode = methodInvocationObject(node);
  if (
    (name === 'fromPath' || name === 'fromUriString' || name === 'fromHttpUrl') &&
    objectNode?.text === 'UriComponentsBuilder'
  ) {
    // Strip any `?query` baked into the seed literal so a later `.path()` appends
    // to a clean base; otherwise the sub-path is glued after the query
    // (`/base?x=1/sub`) and normalizeHttpPath truncates the whole tail at `?`.
    // A host prefix (`https://h/api`) is preserved and stripped downstream by
    // normalizeConsumerPath.
    const seed = firstLiteralArgument(node);
    return seed === null ? null : seed.split('?')[0];
  }
  if (!objectNode) return null;
  if (name === 'path') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1);
    const subPath = firstLiteralArgument(node);
    if (base === null || subPath === null) return null;
    // Spring `UriComponentsBuilder.path(p)` appends `p` VERBATIM (no slash
    // inserted — unlike `pathSegment`, which slash-joins), then normalizes the
    // full path to collapse duplicate slashes. So `fromPath("/api").path("users")`
    // → `/apiusers`, while `.path("/users")` → `/api/users`, and a trailing-slash
    // base collapses (`/api/` + `/users` → `/api/users`). The `(?<!:)` keeps a
    // scheme `://` in a host seed intact; the downstream normalizer is the other
    // slash-collapser for consumer paths (see KTD2 — do not remove it).
    return (base + subPath).replace(/(?<!:)\/{2,}/g, '/');
  }
  if (name === 'pathSegment') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1);
    if (base === null) return null;
    const args = methodInvocationArguments(node);
    const segments = args
      .map((arg) => (arg.type === 'string_literal' ? unquoteLiteral(arg.text) : null))
      .filter((segment): segment is string => segment !== null);
    if (segments.length !== args.length) return null; // a non-literal segment defeats static resolution
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
    return extractUriComponentsBuilderPath(objectNode, depth + 1);
  return null;
}

/**
 * Resolve a statically-derivable path argument to a literal path: a bare
 * string literal, a `URI.create("/x")` call, or a `UriComponentsBuilder`
 * fluent chain. Genuinely dynamic arguments → null.
 */
export function extractStaticPathExpression(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string_literal') return unquoteLiteral(node.text);
  return extractUriCreatePath(node) ?? extractUriComponentsBuilderPath(node);
}

// ─── Builder verb-walks ───────────────────────────────────────────────
// OkHttp / Java-HttpClient encode the request verb on a SIBLING call further up
// the fluent chain, not on the matched path call. Both queries capture the path
// call (`.url(...)` / `.uri(...)`); these helpers recover the verb by walking UP
// the chain — transparent to neutral intervening calls (`.addHeader()`,
// `.header()`, `.timeout()`, `.version()`), which is what lets a header/timeout
// hop between the path call and the terminal still resolve correctly.

/** Walk up the fluent chain from `pathCall`, returning the verb a `name`-matching
 *  helper or a `.method("LITERAL")` call sets. `null` means "verb is set but not
 *  statically resolvable" (a non-literal `.method(verb)`) → the caller skips
 *  rather than guessing. `defaultVerb` is returned only when the walk reaches the
 *  chain top with no verb call (a bare build). `verbHelpers` are matched on the
 *  method NAME (OkHttp helpers are lowercase, HttpClient helpers uppercase). */
function inferBuilderVerb(
  pathCall: Parser.SyntaxNode,
  verbHelpers: readonly string[],
  defaultVerb: string,
): string | null {
  let cur: Parser.SyntaxNode = pathCall;
  let parent = cur.parent;
  while (parent?.type === 'method_invocation' && methodInvocationObject(parent)?.id === cur.id) {
    const name = methodInvocationName(parent);
    if (name && verbHelpers.includes(name)) return name.toUpperCase();
    // Explicit `.method(...)`: a non-empty string-literal verb resolves; a
    // non-literal (variable-bound) OR empty-string verb is unresolvable → null
    // (skip), NOT a guessed default or a malformed empty-method contract.
    if (name === 'method') {
      const verb = firstLiteralArgument(parent);
      return verb ? verb.toUpperCase() : null;
    }
    cur = parent;
    parent = parent.parent;
  }
  return defaultVerb;
}

const OK_HTTP_VERB_HELPERS = ['get', 'head', 'post', 'put', 'delete', 'patch'] as const;
const HTTP_CLIENT_VERB_HELPERS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'] as const;

/**
 * Infer an OkHttp request verb by walking UP the builder chain from the matched
 * `.url(...)` call: the first `.get()/.head()/.post()/.put()/.delete()/.patch()`
 * helper, or a `.method("VERB", …)` literal, wins. Returns `'GET'` only when the
 * chain has NO verb call at all (a bare `.url(...).build()` — OkHttp's real
 * default). Returns `null` for an explicit `.method(verb, …)` whose verb is a
 * non-literal: the verb is set but not statically resolvable, so the caller
 * skips the call rather than asserting a wrong GET (parity with the WebClient
 * long-form variable-bound-verb behavior, which also skips).
 */
export function inferOkHttpMethod(urlCall: Parser.SyntaxNode): string | null {
  return inferBuilderVerb(urlCall, OK_HTTP_VERB_HELPERS, 'GET');
}

/**
 * Infer a Java-`HttpClient` request verb by walking UP the builder chain from the
 * matched `.uri(URI.create("..."))` call: the first `.GET()/.POST()/.PUT()/`
 * `.DELETE()/.HEAD()` verb-helper, or a `.method("VERB", body)` literal, wins.
 * Returns `'GET'` only when the chain has no verb call (a bare `.build()` — the
 * builder's real default). Returns `null` for an explicit `.method(verb, …)` with
 * a non-literal verb (skip, not a guessed GET). The walk is transparent to
 * intervening neutral calls AFTER `.uri()` (`.header()`/`.timeout()`/`.version()`),
 * so a header/timeout hop before the terminal no longer drops the contract.
 * (A call BEFORE `.uri()` is outside the query root and is a separate,
 * pre-existing limitation — see java.ts OK_HTTP_PATTERNS comment.)
 */
export function inferHttpClientMethod(uriCall: Parser.SyntaxNode): string | null {
  return inferBuilderVerb(uriCall, HTTP_CLIENT_VERB_HELPERS, 'GET');
}
