// Next.js route extraction utilities.
//
// Converts file paths to route URLs, extracts HTTP methods from App Router
// route handlers, normalises fetch URLs, and matches fetch calls to routes.

// Convert a Next.js file path to its API route URL.
// Supports both App Router (app/**/route.ts) and Pages Router
// (pages/api/**/*.ts) conventions.
// Returns the route URL (e.g. /api/grants) or null if the path is not a
// recognised route handler.
export function nextjsFileToRouteURL(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');

  // App Router: app/**/api/**/route.ts (restrict to API routes to avoid noise
  // from page-level route handlers that fetch() calls won't match anyway).
  // Route groups like (admin) may appear before api/.
  const appMatch = normalized.match(/app\/(.+?)\/route\.(ts|js|tsx|jsx)$/);
  if (appMatch) {
    // Strip route groups: (admin), (marketing) etc. are not URL segments
    const stripped = appMatch[1].replace(/\([^)]+\)\/?/g, '');
    // Only match if the path contains an api/ segment
    if (!stripped.startsWith('api/') && stripped !== 'api') return null;
    return '/' + stripped;
  }

  // Pages Router: pages/api/**/*.ts
  const pagesMatch = normalized.match(/pages\/(api\/.+?)\.(ts|js|tsx|jsx)$/);
  if (pagesMatch) {
    let route = '/' + pagesMatch[1];
    route = route.replace(/\/index$/, '');
    return route;
  }

  return null;
}

// Normalise a fetch URL so it can be matched against route patterns.
// - Strips query strings (?page=1)
// - Replaces template-literal expressions (${slug}) with [param]
// - Returns null for URLs that cannot be statically resolved (string
//   concatenation, function calls, non-API paths).
export function normalizeFetchURL(rawURL: string): string | null {
  let url = rawURL.split('?')[0];
  url = url.replace(/\$\{[^}]+\}/g, '[param]');
  url = url.replace(/^`|`$/g, '');
  // Strip file extensions from URLs (PHP projects use /api/upload.php but routes are /api/upload)
  url = url.replace(/\.(php|asp|aspx|jsp|cgi)$/, '');

  if (url.includes('+') || url.includes('(')) return null;
  // Must be an absolute path
  if (!url.startsWith('/')) return null;

  return url;
}

// Check whether a (normalised) fetch URL matches a Next.js route pattern.
// Dynamic segments on either side (e.g. [param], [slug]) are treated as
// wildcards that match any single path segment.
export function routeMatches(fetchURL: string, routeURL: string): boolean {
  const fetchParts = fetchURL.split('/').filter(Boolean);
  const routeParts = routeURL.split('/').filter(Boolean);

  // Check for catch-all route: [...param] or optional catch-all [[...param]]
  const lastRoutePart = routeParts[routeParts.length - 1];
  if (lastRoutePart?.startsWith('[...') || lastRoutePart?.startsWith('[[...')) {
    // Catch-all: match if fetch has at least as many segments as route (minus catch-all)
    if (fetchParts.length < routeParts.length - 1) return false;
    return routeParts.slice(0, -1).every((part, i) => {
      if (part.startsWith('[') || fetchParts[i].startsWith('[')) return true;
      return part === fetchParts[i];
    });
  }

  if (fetchParts.length !== routeParts.length) return false;

  return fetchParts.every((part, i) => {
    if (part.startsWith('[') || routeParts[i].startsWith('[')) return true;
    return part === routeParts[i];
  });
}
