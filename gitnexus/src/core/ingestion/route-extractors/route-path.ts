import { isTestFilePath } from '../utils/test-file-path.js';

/**
 * Shared route-path normalization, route identity, and test-file classification.
 *
 * Extracted from the routes phase so both the routes phase (which creates the
 * `Route` graph node, keyed by `(method, url)` via `routeNodeKey` — #2289) and
 * the parse phase (which resolves each route's handler symbol and needs the
 * SAME key to associate the resolved id back to the route) can compute an
 * identical route identity without a phase-to-phase import cycle. Test-route
 * classification reuses the shared test-file path classifier.
 */

/**
 * Join a route's path with its (optional) prefix into a normalized,
 * leading-slash URL used as the Route node identity. Collapses duplicate
 * slashes and strips trailing ones; an empty result degrades to `/`.
 */
export function normalizeExtractedRoutePath(routePath: string, prefix: string | null): string {
  const pathPart = routePath.trim().replace(/^\/+/, '').replace(/\/+$/g, '');
  const prefixPart = prefix?.trim().replace(/^\/+/, '').replace(/\/+$/g, '');
  const joined = prefixPart ? `/${prefixPart}${pathPart ? `/${pathPart}` : ''}` : `/${pathPart}`;
  return joined.replace(/\/+/g, '/') || '/';
}

const VALID_HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

/**
 * Canonicalize a route's HTTP verb for persistence on the Route node and for
 * the route identity key. Returns an upper-cased standard method, `'*'` for a
 * method-agnostic route (e.g. a Django function view), or `undefined` when the
 * value is not a real HTTP verb. Laravel `Route::resource` / `apiResource`
 * surface values like `resource` / `apiResource` (they expand to several verbs
 * at runtime), so they come back `undefined` — keeping the column clean and
 * letting the contract extractor fall back to its source-scan path.
 */
export function normalizeRouteMethod(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const verb = raw.trim().toUpperCase();
  // '*' marks a method-agnostic route. Preserve it so the contract layer emits a
  // wildcard provider that matches consumers of any method.
  if (verb === '*') return '*';
  return VALID_HTTP_METHODS.has(verb) ? verb : undefined;
}

/**
 * The Route node identity (#2289): `(method, path)` when the verb is known and
 * specific, falling back to URL-only when the method is `undefined` (filesystem
 * routes, Laravel `resource`/`apiResource`) or `'*'` (method-agnostic routes,
 * e.g. Django function views). The URL-fallback keeps those byte-identical to
 * the pre-#2289 URL-only ids, so only genuine declaration-style multi-verb
 * routes (`GET /x` + `POST /x`) split into separate nodes.
 *
 * Used by the routes phase (node id + registry key), the processes phase
 * (ENTRY_POINT_OF), and the handler-symbol resolver — all three must key
 * identically.
 */
export function routeNodeKey(method: string | undefined, url: string): string {
  return method && method !== '*' ? `${method} ${url}` : url;
}

/** Keep test registrations available, but let production files win duplicate route identities. */
export function isTestRouteFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return isTestFilePath(normalized) || /(^|\/)e2e(\/|$)/i.test(normalized);
}

/**
 * Strip LEADING template interpolations from a consumer url as gateway/host
 * bindings — the enterprise wrapper shape `` `${serviceClient}/api/v1/x` ``
 * where `${serviceClient}` selects the gateway service, not a route segment.
 * This is consumer-path framework semantics (mirrors how an absolute
 * `https://host/path` url keeps only its path), so the group consumer
 * normalizer and the graph's `normalizeFetchURL` (#3488) share it rather than
 * any one language plugin owning it:
 *   - `` `${c}/api/x` ``      → `/api/x`   (clean prefix; `${c}${d}/api/x` → `/api/x`)
 *   - `` `${c}/api/x/${id}` ``→ `/api/x/${id}` (mid/tail interpolations are left for the `{param}` pass)
 * Returns null when the stripped remainder is not a single-slash path:
 *   - remainder without `/` — relative fragment (`${c}api/x`) or scheme/host
 *     (`${scheme}://${host}/api/x`); whether it is a path depends on
 *     unverifiable runtime state, so it is dropped rather than guessed at;
 *   - remainder starting with `//` — protocol-relative (`${proto}//host/api/x`);
 *     keeping it would later collapse to `/host/api/x`.
 *
 * The `?` in a query string cannot leak into the brace matching: `${...}`
 * spans are matched by braces here (before any `{param}` replacement), and
 * `normalizeHttpPath` splits on `?` only after the whole `${...}` span —
 * including any `?` inside it — has been collapsed to `{param}`. So
 * `` `${c}/api/x?id=${id}` `` reduces to `/api/x` on both orderings.
 */
export function stripLeadingTemplatePrefix(url: string): string | null {
  if (!url.startsWith('${')) return url;
  const rest = url.replace(/^(?:\$\{[^}]*\})+/, '');
  return rest.startsWith('/') && !rest.startsWith('//') ? rest : null;
}
