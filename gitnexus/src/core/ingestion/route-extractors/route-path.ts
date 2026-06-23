/**
 * Shared route-path normalization.
 *
 * Extracted from the routes phase so both the routes phase (which creates the
 * `Route` graph node, keyed by the normalized URL) and the parse phase (which
 * resolves each route's handler symbol and needs the SAME key to associate the
 * resolved id back to the route) can compute an identical route URL without a
 * phase-to-phase import cycle. Pure string logic, no dependencies.
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
