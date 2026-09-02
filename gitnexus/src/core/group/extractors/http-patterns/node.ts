import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type CompiledPatterns,
  type LanguagePatterns,
  type PatternSpec,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin, RepoContext } from './types.js';
import { MAX_FOLD_LENGTH } from '../../../ingestion/route-extractors/constant-resolver.js';
import {
  DATA_ROUTE_TABLE_SOURCE,
  scanDataRouteTables,
} from '../../../ingestion/route-extractors/data-route-table.js';
import { extractNestRoutes } from '../../../ingestion/route-extractors/nest.js';
import { normalizeExtractedRoutePath } from '../../../ingestion/route-extractors/route-path.js';
import {
  buildJsRepoFacts,
  extractJsModuleFacts,
  isAxiosNamespace,
  isHttpClientRef,
  resolveJsPathExpression,
  type JsModuleFacts,
  type JsRepoFacts,
} from '../../../ingestion/route-extractors/js-const-resolver.js';

/**
 * Node.js / TypeScript HTTP plugin family. Handles:
 *   - NestJS `@Controller('prefix')` classes with `@Get(':id')` methods,
 *     delegated wholesale to the indexer's `extractNestRoutes`
 *   - Express `router.get(...)` / `app.post(...)` providers
 *   - `fetch(url)` / `fetch(url, { method: 'POST' })` consumers
 *   - `axios.get(url)` / `axios.delete(url)` consumers
 *   - `axios({ method, url })` object-form consumers
 *   - jQuery `$.get(url)` / `$.post(url, ...)` shorthand consumers
 *   - jQuery `$.ajax({ url, method | type })` consumers
 *
 * Because the JavaScript and TypeScript tree-sitter grammars share
 * node type names for every construct we query, pattern sources are
 * defined once and compiled against each grammar variant. The plugin
 * exports three `HttpLanguagePlugin`s (JS, TS, TSX) that share the
 * same `scan` function but bind to different grammars.
 */

// NestJS providers are not queried here at all — see the `extractNestRoutes`
// call in `scanBundle`.

// ─── Provider: Express — router.get/app.post/... ─────────────────────
const EXPRESS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#match? @obj "^(router|app)$")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post|put|delete|patch)$"))
      arguments: (arguments . [(string) (template_string)] @path . (_)? @handler))
  `,
};

// ─── Consumer: fetch(url) with NO options ─────────────────────────────
const FETCH_NO_OPTIONS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "fetch")
      arguments: (arguments . [(string) (template_string)] @path .))
  `,
};

// ─── Consumer: fetch(url, { method: 'X', ... }) ──────────────────────
const FETCH_WITH_OPTIONS_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "fetch")
      arguments: (arguments
        . [(string) (template_string)] @path
        (object
          (pair
            key: (property_identifier) @key (#eq? @key "method")
            value: (string) @http_method))))
  `,
};

// ─── Consumer: <httpClient>.get/post/... ─────────────────────────────
// Widened from a literal `axios` receiver with a literal path. Application
// code satisfies neither: it calls through a configured instance
// (`const api = axios.create({ baseURL })`, imported at the call site under
// whatever name the app chose) and passes the path by reference from a shared
// route table (`api.get(API_ROUTE_PATH.LINKS)`). The query therefore matches
// ANY identifier receiver with an HTTP-verb method and ANY first argument;
// `scanBundle` admits a match only after PROVING the receiver is an axios
// instance and resolving the argument to a path.
//
// The proof gate is load-bearing, not belt-and-braces: EXPRESS_SPEC above
// matches `router.get('/x', handler)` / `app.post(...)` as PROVIDERS. A
// receiver admitted on spelling alone would re-emit every Express route in the
// repo as a consumer of itself, on both sides of every cross-repo pair.
const HTTP_CLIENT_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj
        property: (property_identifier) @http_method (#match? @http_method "^(get|post|put|delete|patch)$"))
      arguments: (arguments . (_) @path))
  `,
};

// ─── Consumer: jQuery shorthand $.get(url) / $.post(url, ...) ────────
// `$` is a valid JS identifier, so tree-sitter parses `$.get(...)` as a
// call_expression whose function is a member_expression on identifier `$`.
const JQUERY_SHORTHAND_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "$")
        property: (property_identifier) @http_method (#match? @http_method "^(get|post)$"))
      arguments: (arguments . [(string) (template_string)] @path))
  `,
};

// ─── Consumer: jQuery $.ajax({ url, method|type }) ───────────────────
// The query captures the options object only; key/value pairs are read
// programmatically via `readStringProp` below, which tolerates any key
// order and accepts either `method:` or `type:` (jQuery supports both).
const JQUERY_AJAX_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (identifier) @obj (#eq? @obj "$")
        property: (property_identifier) @fn (#eq? @fn "ajax"))
      arguments: (arguments (object) @options))
  `,
};

// ─── Consumer: axios({ method, url }) object form ────────────────────
// Distinct from AXIOS_SPEC above because the call target is an identifier
// (`axios`) rather than a member expression (`axios.get`). As with the
// jQuery ajax form, option keys are resolved programmatically.
const AXIOS_OBJECT_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (identifier) @fn (#eq? @fn "axios")
      arguments: (arguments (object) @options))
  `,
};

// ─── Consumer: wrapped client X.request({ url, method }) ────────────
// Enterprise wrapper shape: an axios instance (or a named request helper)
// re-exported under a local name — `httpClient.request({ url, method })`
// from `@winex-plugin/win-request`, `$http.request(...)`. Generic names
// like `api` need axios.create/import proof (`isHttpClientRef`); spelling
// alone is too common (graphql-request helpers, domain `api` objects).
// The member property is `request` (not an HTTP verb), so this cannot
// collide with the Express provider pattern (`router.get`) or the axios
// member form (`axios.get`). Option keys are resolved programmatically,
// same as the jQuery ajax / axios object forms.
//
// The query captures the receiver so scan can reject unrelated
// `.request({ url })` APIs (`cy.request`, `queue.request`).
const REQUEST_OBJECT_SPEC: PatternSpec<Record<string, never>> = {
  meta: {},
  query: `
    (call_expression
      function: (member_expression
        object: (_) @obj
        property: (property_identifier) @fn (#eq? @fn "request"))
      arguments: (arguments (object) @options))
  `,
};

/**
 * Receivers admitted as wrapped HTTP clients without axios.create proof.
 * Spelling-only: the last identifier in `obj.text` (`this.$http` → `$http`).
 * Keep this set small — every extra name is a false-positive surface.
 */
const WRAPPED_REQUEST_RECEIVERS = new Set(['httpClient', '$http']);

interface NodePatternBundle {
  express: CompiledPatterns<Record<string, never>>;
  fetchNoOptions: CompiledPatterns<Record<string, never>>;
  fetchWithOptions: CompiledPatterns<Record<string, never>>;
  httpClient: CompiledPatterns<Record<string, never>>;
  jqueryShorthand: CompiledPatterns<Record<string, never>>;
  jqueryAjax: CompiledPatterns<Record<string, never>>;
  axiosObject: CompiledPatterns<Record<string, never>>;
  requestObject: CompiledPatterns<Record<string, never>>;
}

function compileBundle(language: unknown, name: string): NodePatternBundle {
  const mk = (spec: PatternSpec<Record<string, never>>, suffix: string) =>
    compilePatterns({
      name: `${name}-${suffix}`,
      language,
      patterns: [spec],
    } satisfies LanguagePatterns<Record<string, never>>);
  return {
    express: mk(EXPRESS_SPEC, 'express'),
    fetchNoOptions: mk(FETCH_NO_OPTIONS_SPEC, 'fetch-no-options'),
    fetchWithOptions: mk(FETCH_WITH_OPTIONS_SPEC, 'fetch-with-options'),
    httpClient: mk(HTTP_CLIENT_SPEC, 'http-client'),
    jqueryShorthand: mk(JQUERY_SHORTHAND_SPEC, 'jquery-shorthand'),
    jqueryAjax: mk(JQUERY_AJAX_SPEC, 'jquery-ajax'),
    axiosObject: mk(AXIOS_OBJECT_SPEC, 'axios-object'),
    requestObject: mk(REQUEST_OBJECT_SPEC, 'request-object'),
  };
}

const JAVASCRIPT_BUNDLE = compileBundle(JavaScript, 'javascript-http');
const TYPESCRIPT_BUNDLE = compileBundle(TypeScript.typescript, 'typescript-http');
const TSX_BUNDLE = compileBundle(TypeScript.tsx, 'tsx-http');

/**
 * Unquoted object-literal key. Quoted `"method"` / `'url'` keep the quotes
 * on `keyNode.text`; compare against the unquoted name so both spellings match.
 */
function objectKeyName(keyNode: Parser.SyntaxNode): string | null {
  if (keyNode.type === 'string' || keyNode.type === 'template_string') {
    return unquoteLiteral(keyNode.text);
  }
  return keyNode.text;
}

/**
 * Walk `pair` children of an `object` literal and return the unquoted
 * string/template_string value for the first pair whose key matches one
 * of `keyNames`. Returns null when no matching pair is present or the
 * value is not a string literal. Used by the jQuery ajax / axios object
 * consumers to resolve `url` / `method` / `type` keys in any order.
 */
function readStringProp(objectNode: Parser.SyntaxNode, keyNames: readonly string[]): string | null {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const pair = objectNode.namedChild(i);
    if (!pair || pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName('key');
    const valueNode = pair.childForFieldName('value');
    if (!keyNode || !valueNode) continue;
    const key = objectKeyName(keyNode);
    if (key === null || !keyNames.includes(key)) continue;
    if (valueNode.type !== 'string' && valueNode.type !== 'template_string') continue;
    const lit = unquoteLiteral(valueNode.text);
    if (lit !== null) return lit;
  }
  return null;
}

/**
 * True when the object literal has a pair / shorthand whose key is one of
 * `keyNames`, or a spread (`...config`) that may supply those keys at runtime.
 */
function hasObjectKey(objectNode: Parser.SyntaxNode, keyNames: readonly string[]): boolean {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (!child) continue;
    if (child.type === 'spread_element') return true;
    if (
      (child.type === 'shorthand_property_identifier' ||
        child.type === 'shorthand_property_identifier_pattern') &&
      keyNames.includes(child.text)
    ) {
      return true;
    }
    if (child.type !== 'pair') continue;
    const keyNode = child.childForFieldName('key');
    if (!keyNode) continue;
    const key = objectKeyName(keyNode);
    if (key !== null && keyNames.includes(key)) return true;
  }
  return false;
}

/**
 * Verb for wrapped `X.request({ url, method|type })`. Absent key → GET
 * (same default as fetch-without-options / jQuery ajax). Present but not a
 * string/template, or supplied only via object spread → `*` so matching
 * can still link without pinning GET.
 */
function readRequestMethod(objectNode: Parser.SyntaxNode): string {
  const rawMethod = readStringProp(objectNode, ['method', 'type']);
  if (rawMethod !== null) {
    // `` method: `${verb}` `` is a template_string, not a verb literal.
    if (rawMethod.includes('${')) return '*';
    return rawMethod.toUpperCase();
  }
  if (hasObjectKey(objectNode, ['method', 'type'])) return '*';
  return 'GET';
}

function wrappedRequestReceiverName(receiver: string): string {
  const parts = receiver.split('.');
  return parts[parts.length - 1] ?? receiver;
}

/** Axios module / axios.create instance, or a registered wrapper identifier. */
function isAdmittedWrappedRequestReceiver(
  receiver: string,
  fileKey: string | undefined,
  facts: JsRepoFacts | null,
): boolean {
  if (WRAPPED_REQUEST_RECEIVERS.has(wrappedRequestReceiverName(receiver))) return true;
  try {
    const isModule =
      facts === null || fileKey === undefined
        ? receiver === 'axios'
        : isAxiosNamespace(fileKey, receiver, facts);
    if (isModule) return true;
    if (!facts || fileKey === undefined) return false;
    return isHttpClientRef(fileKey, receiver, facts);
  } catch {
    return false;
  }
}

/**
 * Map each named import's LOCAL binding to its DECLARED export name and source
 * module, by walking the file's `import { x as y } from 'm'` statements. Lets
 * the express handler resolve through an alias (the local `y`) to the real
 * symbol (`x` in `m`) instead of looking up the alias text. Only named imports
 * are mapped — default and namespace imports are left to fall through as
 * locally-scoped identifiers.
 */
function buildImportMap(tree: Parser.Tree): Map<string, { name: string; module: string }> {
  const map = new Map<string, { name: string; module: string }>();
  // Both walks are explicit-stack, not recursive. They visit EVERY node of the
  // file, so their depth is the source's nesting depth — and `scan` may not
  // throw: a `RangeError` here escapes to `sync.ts`, which records the repo as
  // an unexplained "missing repo" and drops every contract of every kind for
  // it, silently. A file nesting template substitutions ~4 000 deep (well
  // inside what tree-sitter will parse) was enough.
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop() as Parser.SyntaxNode;
    if (node.type === 'import_statement') {
      const sourceNode = node.childForFieldName('source');
      const module = sourceNode ? unquoteLiteral(sourceNode.text) : null;
      if (module !== null) {
        const inner: Parser.SyntaxNode[] = [node];
        while (inner.length > 0) {
          const n = inner.pop() as Parser.SyntaxNode;
          if (n.type === 'import_specifier') {
            const nameNode = n.childForFieldName('name');
            const aliasNode = n.childForFieldName('alias');
            const local = aliasNode ?? nameNode;
            if (nameNode && local && local.type === 'identifier') {
              map.set(local.text, { name: nameNode.text, module });
            }
          }
          for (const c of n.namedChildren) inner.push(c);
        }
      }
      // An import statement cannot contain another one, and the inner loop has
      // already visited its whole subtree.
      continue;
    }
    for (const c of node.namedChildren) stack.push(c);
  }
  return map;
}

// ─── Repo pre-pass: cross-file route tables + HTTP client instances ──
//
// Both halves of a real consumer call live in files OTHER than the call site:
// the client is created in `lib/axios.config.ts` and the path in
// `shared/api-routes.ts`. A per-file scan cannot see either, which is why the
// literal-only patterns matched almost nothing on application code. The
// pre-pass builds a repo-wide fact map once so `scan` can resolve both.

interface NodeRepoContext {
  readonly facts: JsRepoFacts;
}

/**
 * Shared across the three JS/TS plugins.
 *
 * JS, TS and TSX are distinct `HttpLanguagePlugin` objects, and the
 * orchestrator caches `prepareRepo` output per plugin NAME — so a polyglot
 * frontend would build this identical map three times. All three are called
 * with the same memoized file-list array within one extraction run, so keying
 * on that array's identity collapses the work to a single pass. A later run
 * passes a different array and correctly rebuilds; the weak key lets the old
 * map be collected with it.
 */
const REPO_CONTEXT_BY_FILE_LIST = new WeakMap<readonly string[], NodeRepoContext>();

/**
 * Skip ceiling for the pre-pass, mirroring the analyzer's default
 * `--max-file-size`. A minified bundle is megabytes on one line and defines no
 * route table a human wrote; parsing it costs far more than it can return.
 */
const MAX_PREPASS_FILE_BYTES = 512 * 1024;

/** Repo-relative path in the same POSIX form the fact map is keyed by. */
function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** The grammar a JS/TS-family file should be parsed with, or null if not one. */
function grammarForFile(rel: string): unknown | null {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.tsx')) return TypeScript.tsx;
  if (/\.[cm]?ts$/.test(lower)) return TypeScript.typescript;
  if (/\.[cm]?jsx?$/.test(lower)) return JavaScript;
  return null;
}

function buildNodeRepoContext(args: {
  files: string[];
  readFile: (rel: string) => string | null;
  parseSource: (parser: Parser, src: string) => Parser.Tree | null;
}): NodeRepoContext {
  const cached = REPO_CONTEXT_BY_FILE_LIST.get(args.files);
  if (cached) return cached;

  const byFile = new Map<string, JsModuleFacts>();
  const parsers = new Map<unknown, Parser>();
  const parserFor = (language: unknown): Parser => {
    let parser = parsers.get(language);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(language as Parameters<Parser['setLanguage']>[0]);
      parsers.set(language, parser);
    }
    return parser;
  };

  // Cost gate, in the spirit of the sibling `python.ts` pre-pass: every fact
  // this map holds exists to prove a receiver is an axios instance or to fold a
  // path for one. A repo where the string `axios` appears nowhere can prove no
  // receiver, so every parse below is dead work — and parsing is the expensive
  // half (measured 4.36 s / +258 MB RSS over 827 TypeScript files, on top of
  // the parse `getScanInput` already does).
  // Only the file's identity is carried between the passes, never its text: a
  // large monorepo's whole source tree held in one array at once is the shape
  // that produced the analyzer's scale problems, and the second read is cheap
  // beside the parse it gates.
  const eligible: Array<{ rel: string; language: unknown }> = [];
  let sawAxios = false;
  for (const rel of args.files) {
    const language = grammarForFile(rel);
    if (language === null) continue;
    const content = args.readFile(rel);
    // `MAX_PREPASS_FILE_BYTES` is a BYTE ceiling; `String.length` counts UTF-16
    // code units, which under-counts every multi-byte source.
    if (content === null || Buffer.byteLength(content, 'utf8') > MAX_PREPASS_FILE_BYTES) continue;
    if (!sawAxios && content.includes('axios')) sawAxios = true;
    eligible.push({ rel, language });
  }

  if (sawAxios) {
    for (const { rel, language } of eligible) {
      try {
        const content = args.readFile(rel);
        if (content === null) continue;
        // `parseSource` belongs INSIDE the guard: `safe-parse.ts` throws
        // `ParseTimeoutError` and makes catching it a per-caller obligation, and
        // `prepareRepo` is contractually non-throwing. One escape here left the
        // fact map unwritten for the WHOLE repo — and, because the orchestrator
        // caches per plugin NAME, made all three JS/TS plugins re-walk it and
        // fail the same way before falling back to literal-only scanning.
        const tree = args.parseSource(parserFor(language), content);
        if (!tree) continue;
        byFile.set(normalizeRel(rel), extractJsModuleFacts(tree));
      } catch {
        // One malformed file must never abort the pre-pass — it simply stays
        // unresolved, exactly as it is without this pass at all.
      }
    }
  }

  const ctx: NodeRepoContext = { facts: buildJsRepoFacts(byFile) };
  REPO_CONTEXT_BY_FILE_LIST.set(args.files, ctx);
  return ctx;
}

/** The repo facts to resolve against, or null when there was no pre-pass. */
function resolveFactsFor(
  repoContext: RepoContext | undefined,
  fileRel: string | undefined,
): JsRepoFacts | null {
  const ctx = repoContext as NodeRepoContext | undefined;
  if (!ctx || fileRel === undefined) return null;
  return ctx.facts;
}

/**
 * Whether a folded first argument is plausibly a URL path.
 *
 * The query now captures ANY first argument, and "it folded to a string" is not
 * "it is a path" — `normalizeConsumerPath` is a canonicalizer, not a validator,
 * and it happily turns non-paths into contracts that exact-match real provider
 * routes:
 *
 *   api.get(CONFIG.TIMEOUT)  // "5000"                     -> http::GET::/{param}
 *   api.post(MSG.ERROR)      // "Could not reach the …"    -> http::POST::/could not reach the server
 *
 * `/{param}` matches every one-segment provider route in the group, and
 * `matching.exclude_links_param_only_paths` defaults to `false`. A path whose
 * leading term is an unresolved placeholder is refused unless the next
 * character is `/` — that is the gateway-prefix shape
 * `` `${serviceClient}/api/v1/x` `` that `stripLeadingTemplatePrefix` keeps.
 * Bare `{param}` and `{param}api/x` stay rejected: nothing pins a route.
 */
function looksLikeHttpPath(path: string): boolean {
  if (path === '') return false;
  if (/^https?:\/\//i.test(path)) return true;
  // A `${…}` term is a runtime value that `normalizeConsumerPath` rewrites to
  // `{param}`; its SOURCE text can be any expression (`${draft ? 'a' : 'b'}`,
  // `${id ?? ''}`), so the checks below have to run against the normalized
  // shape. Testing the raw source dropped every partially folded path whose
  // unresolved term happened to contain a space.
  const shape = path.replace(/\$\{[^}]+\}/g, '{param}');
  if (/\s/.test(shape)) return false;
  if (shape.startsWith('{param}')) return shape.startsWith('{param}/');
  // An all-digit string is a path only when it is written as one. A leading
  // slash is that evidence: `client.get('/123')` is a route whose segment the
  // consumer normalizer reads as `{param}`, while a bare `"5000"` folded out of
  // `CONFIG.TIMEOUT` is a timeout that would match every one-segment provider.
  if (!shape.startsWith('/')) return !/^\d+$/.test(shape);
  return true;
}

/**
 * The path a consumer call's first argument denotes.
 *
 * Prefers full resolution against the repo facts; falls back to the raw
 * literal for a string/template node so a repo with no pre-pass (or an
 * unresolvable reference) behaves exactly as it did before.
 *
 * `fileKey` is already `normalizeRel`-ed by the caller — see `scanBundle`.
 *
 * `legacyShape` marks the exact combination this pattern matched BEFORE it was
 * widened: the literal receiver `axios` with a string or template-string first
 * argument. That combination keeps its old output verbatim, so this PR adds
 * detections without removing any — `axios.get(`${API_BASE}/users`)` still
 * yields `/{param}/users`. Everything the widened query NEWLY admits (any other
 * receiver, or any non-literal argument) has to clear the gates.
 */
function resolveConsumerPath(
  pathNode: Parser.SyntaxNode,
  facts: JsRepoFacts | null,
  fileKey: string | undefined,
  legacyShape: boolean,
): string | null {
  if (facts && fileKey !== undefined) {
    const resolved = resolveJsPathExpression(fileKey, pathNode, facts);
    if (resolved !== null && looksLikeHttpPath(resolved)) return resolved;
  }
  // The fallback is deliberately gated on node TYPE: `unquoteLiteral` returns
  // unrecognized input unchanged, so handing it a `member_expression` would
  // yield the literal text `API_ROUTE_PATH.LINKS` as if it were a URL path.
  if (pathNode.type !== 'string' && pathNode.type !== 'template_string') return null;
  const literal = unquoteLiteral(pathNode.text);
  // The fold bails past `MAX_FOLD_LENGTH`; the raw source it falls back to has
  // no such bound and lands in `contractId` and `meta.path` all the same.
  if (literal === null || literal.length > MAX_FOLD_LENGTH) return null;
  return legacyShape || looksLikeHttpPath(literal) ? literal : null;
}

function scanBundle(
  bundle: NodePatternBundle,
  tree: Parser.Tree,
  repoContext?: RepoContext,
  fileRel?: string,
): HttpDetection[] {
  const out: HttpDetection[] = [];
  // Repo-wide constant / HTTP-client facts, when the orchestrator ran the
  // `prepareRepo` pre-pass. Absent for a bare `scan(tree)` call, in which case
  // every cross-file resolution below floors to the literal-only behavior.
  const facts = resolveFactsFor(repoContext, fileRel);
  // The fact map is keyed by `normalizeRel(rel)`. Normalizing at ONE place and
  // using that value for every read keeps the two sides in step: the receiver
  // gate used to read the raw `fileRel`, and `isHttpClientRef` cannot tell a key
  // miss from "not a client", so any non-POSIX path (glob v13 has no
  // `posix: true` and its walker joins with the platform separator; graph rows
  // are a second unnormalized source) silently returned zero consumers.
  const fileKey = fileRel === undefined ? undefined : normalizeRel(fileRel);
  // Local-binding → { declared export name, module } for the file's named
  // imports, so an express handler that is an imported (possibly aliased)
  // symbol resolves to the real definition rather than its local alias text.
  const importMap = buildImportMap(tree);

  // NestJS: delegated to the indexer's extractor rather than re-queried here.
  // Two independent readings of the same decorators is how the layers drift:
  // the local scan saw only `class_declaration` (never `abstract class`), only
  // five of the nine verbs, only a positional string `@Controller('x')`, and
  // — worst — INVENTED `/` for a method path it could not read, so
  // `@Get(ROUTES.SEARCH)` became a `GET /venues` contract that the graph, which
  // correctly drops it, has no Route node for. "A missing route is a coverage
  // limit; an invented one is a lie" (ARCHITECTURE.md). Calling the extractor
  // makes that divergence structurally impossible, exactly as the
  // `scanDataRouteTables` call below already does for static route tables.
  //
  // `filePath` rides only on the returned struct and never reaches the
  // `HttpDetection`, so a bare `scan(tree)` with no `fileRel` passes '' rather
  // than losing the routes. `lineOffset` is 0: the group scanner parses whole
  // files, so `lineNumber` is already the absolute 1-based line this
  // `HttpDetection.line` wants.
  for (const route of extractNestRoutes(tree, fileRel ?? '', 0)) {
    out.push({
      role: 'provider',
      framework: 'nest',
      method: route.httpMethod,
      // The prefix travels separately at the ingestion layer, so the join is
      // ours to do — with ingestion's own joiner, so the two layers cannot
      // disagree about the URL either.
      path: normalizeExtractedRoutePath(route.routePath, route.prefix ?? null),
      name: route.handlerName ?? null,
      line: route.lineNumber,
      confidence: 0.8,
    });
  }

  // Express: router/app.<verb>(...)
  for (const match of runCompiledPatterns(bundle.express, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    // Capture the handler argument identifier (`router.get('/x', listUsers)`
    // → `listUsers`) so a named handler resolves by name. For an inline/anonymous
    // handler emit `name: null` (NOT the sentinel `'handler'`) so the resolver
    // does NOT match an unrelated function that happens to be named `handler` —
    // it uses the registration line for containment instead. When the handler is
    // an imported (possibly aliased) symbol, carry the resolved import so the
    // extractor can pin it to the source module rather than the local alias text.
    const handlerNode = match.captures.handler;
    const localHandler = handlerNode?.type === 'identifier' ? handlerNode.text : null;
    const imported = localHandler !== null ? importMap.get(localHandler) : undefined;
    out.push({
      role: 'provider',
      framework: 'express',
      method: methodNode.text.toUpperCase(),
      path,
      name: imported ? imported.name : localHandler,
      handlerImport: imported,
      line: (handlerNode ?? pathNode).startPosition.row + 1,
      confidence: 0.8,
    });
  }

  // Consumer: fetch with options { method: 'X' }
  const fetchSeen = new Set<number>();
  for (const match of runCompiledPatterns(bundle.fetchWithOptions, tree)) {
    const pathNode = match.captures.path;
    const methodNode = match.captures.http_method;
    if (!pathNode || !methodNode) continue;
    const path = unquoteLiteral(pathNode.text);
    const method = unquoteLiteral(methodNode.text);
    if (path === null || method === null) continue;
    fetchSeen.add(pathNode.id);
    out.push({
      role: 'consumer',
      framework: 'fetch',
      method: method.toUpperCase(),
      path,
      name: null,
      line: pathNode.startPosition.row + 1,
      confidence: 0.7,
    });
  }

  // Consumer: plain fetch(path) — default GET. Skip path nodes we already
  // matched with the options variant so we don't double-emit.
  for (const match of runCompiledPatterns(bundle.fetchNoOptions, tree)) {
    const pathNode = match.captures.path;
    if (!pathNode) continue;
    if (fetchSeen.has(pathNode.id)) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'fetch',
      method: 'GET',
      path,
      name: null,
      line: pathNode.startPosition.row + 1,
      confidence: 0.7,
    });
  }

  // Consumer: <httpClient>.<verb>(url) — `axios` itself, or any receiver the
  // repo pre-pass proves is an axios instance.
  for (const match of runCompiledPatterns(bundle.httpClient, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    const objNode = match.captures.obj;
    if (!methodNode || !pathNode || !objNode) continue;

    // Receiver gate. `axios.get(...)` needs no proof; anything else must be
    // traced to an `axios.create(...)` binding, or it is not ours to claim.
    const receiver = objNode.text;

    // Cross-file resolution is the only work in this file that walks a
    // repo-wide graph, and `HttpLanguagePlugin.scan` may not throw: a single
    // hostile call site must cost its own detection, not the repo's whole
    // contract set (`sync.ts` catches a throw here as an unexplained "missing
    // repo", silently, for every contract type).
    try {
      // The receiver is admitted when it IS the axios module — the bare
      // spelling this pattern trusted before it was widened, or a declared
      // import/require of 'axios' under any name — or when it traces to an
      // `axios.create(...)` instance. Nothing else.
      const isModule =
        facts === null || fileKey === undefined
          ? receiver === 'axios'
          : isAxiosNamespace(fileKey, receiver, facts);
      if (!isModule) {
        if (!facts || fileKey === undefined) continue;
        if (!isHttpClientRef(fileKey, receiver, facts)) continue;
      }

      const path = resolveConsumerPath(
        pathNode,
        facts,
        fileKey,
        isModule && (pathNode.type === 'string' || pathNode.type === 'template_string'),
      );
      if (path === null) continue;

      out.push({
        role: 'consumer',
        framework: 'axios',
        method: methodNode.text.toUpperCase(),
        path,
        name: null,
        line: pathNode.startPosition.row + 1,
        confidence: 0.7,
      });
    } catch {
      // Unresolvable is the same outcome as unresolved — skip this call site.
    }
  }

  // Consumer: jQuery shorthand $.get(url) / $.post(url, ...)
  for (const match of runCompiledPatterns(bundle.jqueryShorthand, tree)) {
    const methodNode = match.captures.http_method;
    const pathNode = match.captures.path;
    if (!methodNode || !pathNode) continue;
    const path = unquoteLiteral(pathNode.text);
    if (path === null) continue;
    out.push({
      role: 'consumer',
      framework: 'jquery',
      method: methodNode.text.toUpperCase(),
      path,
      name: null,
      line: pathNode.startPosition.row + 1,
      confidence: 0.7,
    });
  }

  // Consumer: jQuery $.ajax({ url, method|type }). jQuery accepts either
  // `method:` or `type:`; both default to GET when absent.
  for (const match of runCompiledPatterns(bundle.jqueryAjax, tree)) {
    const optionsNode = match.captures.options;
    if (!optionsNode) continue;
    const path = readStringProp(optionsNode, ['url']);
    if (path === null) continue;
    const rawMethod = readStringProp(optionsNode, ['method', 'type']);
    const method = (rawMethod ?? 'GET').toUpperCase();
    out.push({
      role: 'consumer',
      framework: 'jquery',
      method,
      path,
      name: null,
      line: optionsNode.startPosition.row + 1,
      confidence: 0.7,
    });
  }

  // Consumer: axios({ method, url }) object form. Structurally distinct
  // from axios.<verb>(url) (identifier vs member_expression call), so no
  // dedup against the member-form loop above is required.
  for (const match of runCompiledPatterns(bundle.axiosObject, tree)) {
    const optionsNode = match.captures.options;
    if (!optionsNode) continue;
    const path = readStringProp(optionsNode, ['url']);
    if (path === null) continue;
    const method = readRequestMethod(optionsNode);
    out.push({
      role: 'consumer',
      framework: 'axios',
      method,
      path,
      name: null,
      line: optionsNode.startPosition.row + 1,
      confidence: 0.7,
    });
  }

  // Consumer: wrapped client `X.request({ url, method })` — the shared
  // enterprise axios-instance shape (`httpClient.request` from
  // win-request and friends). Emit the raw url (templates intact) so
  // shared `normalizeConsumerPath` can strip a leading `${…}` gateway
  // prefix and fold mid/tail interpolations to `{param}`. A plugin-side
  // longest-slash-segment reducer would truncate those mid-templates
  // before the shared normalizer ever saw them. This scan drops only
  // static relative urls (no `${`, no leading `/`, not `https?://`).
  // That filter is request-wrapper-specific: fetch/axios member forms
  // already admit absolute urls and leave host stripping to
  // `normalizeConsumerPath`.
  for (const match of runCompiledPatterns(bundle.requestObject, tree)) {
    const optionsNode = match.captures.options;
    const objNode = match.captures.obj;
    if (!optionsNode || !objNode) continue;
    if (!isAdmittedWrappedRequestReceiver(objNode.text, fileKey, facts)) continue;
    const rawUrl = readStringProp(optionsNode, ['url']);
    if (rawUrl === null) continue;
    const url = rawUrl.trim();
    if (!url.includes('${') && !url.startsWith('/') && !/^https?:\/\//i.test(url)) continue;
    out.push({
      role: 'consumer',
      framework: 'request',
      method: readRequestMethod(optionsNode),
      path: url,
      name: null,
      line: optionsNode.startPosition.row + 1,
      confidence: 0.65,
    });
  }

  for (const route of scanDataRouteTables(tree)) {
    const imported =
      route.handlerLocalName === undefined ? undefined : importMap.get(route.handlerLocalName);
    out.push({
      role: 'provider',
      framework: DATA_ROUTE_TABLE_SOURCE,
      method: route.method,
      path: route.path,
      // A source-only scan can prove a bare local/imported binding. Member
      // ownership needs the semantic model, so leave it unattributed here;
      // the graph-backed path consumes the exact handlerSymbolId later.
      name: imported?.name ?? (route.handlerLocalName === undefined ? null : route.handlerName),
      ...(imported === undefined ? {} : { handlerImport: imported }),
      strictHandlerResolution: true,
      ...(route.handlerLocalName === undefined ? { unresolvedHandler: true } : {}),
      line: route.line,
      confidence: 0.8,
    });
  }

  return out;
}

export const JAVASCRIPT_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'javascript-http',
  language: JavaScript,
  prepareRepo: buildNodeRepoContext,
  scan: (tree, repoContext, fileRel) => scanBundle(JAVASCRIPT_BUNDLE, tree, repoContext, fileRel),
};

export const TYPESCRIPT_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'typescript-http',
  language: TypeScript.typescript,
  prepareRepo: buildNodeRepoContext,
  scan: (tree, repoContext, fileRel) => scanBundle(TYPESCRIPT_BUNDLE, tree, repoContext, fileRel),
};

export const TSX_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'tsx-http',
  language: TypeScript.tsx,
  prepareRepo: buildNodeRepoContext,
  scan: (tree, repoContext, fileRel) => scanBundle(TSX_BUNDLE, tree, repoContext, fileRel),
};
