import { isPhpRouteFile } from '../languages/php.js';
import type { ExtractedRoute } from './laravel.js';
import {
  joinPhpRouteGroupNamespaces,
  mergeLumenRouteName,
  mergeRoutePrefixes,
  qualifyStringActionController,
} from './php-route-group.js';
import type { ExtractedPhpRouteRequireBinding } from './php-router-require-bindings.js';

export interface PhpRouteRequireContext {
  prefix: string | null;
  namespace: string | null;
  middleware: string[];
  namePrefix: string | null;
}

/**
 * Map repo-relative route file paths to bootstrap group contexts. Bindings apply
 * only when the required path resolves to an indexed routes/*.php file.
 */
export function resolvePhpRouterRequireBindings(
  files: Iterable<string>,
  bindings: readonly ExtractedPhpRouteRequireBinding[],
): Map<string, PhpRouteRequireContext[]> {
  const fileSet = new Set([...files].map((f) => f.replace(/\\/g, '/')));
  const contextsByFile = new Map<string, PhpRouteRequireContext[]>();

  for (const binding of bindings) {
    const target = binding.requiredPath.replace(/\\/g, '/');
    if (!fileSet.has(target) || !isPhpRouteFile(target)) continue;
    const ctx: PhpRouteRequireContext = {
      prefix: binding.prefix,
      namespace: binding.namespace,
      middleware: [...binding.middleware],
      namePrefix: binding.namePrefix,
    };
    const existing = contextsByFile.get(target) ?? [];
    existing.push(ctx);
    contextsByFile.set(target, existing);
  }

  return contextsByFile;
}

function applyContext(route: ExtractedRoute, ctx: PhpRouteRequireContext): ExtractedRoute {
  const prefix = mergeRoutePrefixes(ctx.prefix, route.prefix);
  const middleware = [...ctx.middleware, ...route.middleware];
  const mergedName = route.routeName
    ? mergeLumenRouteName(ctx.namePrefix, route.routeName)
    : ctx.namePrefix;

  let controllerQualifiedName = route.controllerQualifiedName ?? null;
  if (route.stringAction && route.controllerName) {
    const composedNs = route.stringActionGroupNamespaceResets
      ? (route.stringActionGroupNamespace ?? null)
      : joinPhpRouteGroupNamespaces(
          ctx.namespace,
          route.stringActionGroupNamespace ?? null,
          'lumen',
        );
    controllerQualifiedName = qualifyStringActionController(
      route.controllerName,
      composedNs,
      route.stringActionAbsoluteController ?? false,
      route.controllerQualifiedName,
    );
  }

  return {
    ...route,
    prefix,
    middleware,
    routeName: mergedName,
    controllerQualifiedName,
  };
}

/**
 * Expand framework routes with bootstrap group-require contexts. Multiple
 * bindings targeting the same file duplicate routes (same pattern as FastAPI
 * prefix fan-out).
 */
export function applyPhpRouterRequireContexts(
  routes: readonly ExtractedRoute[],
  files: Iterable<string>,
  bindings: readonly ExtractedPhpRouteRequireBinding[],
): ExtractedRoute[] {
  const contextsByFile = resolvePhpRouterRequireBindings(files, bindings);
  if (contextsByFile.size === 0) return [...routes];

  const expanded: ExtractedRoute[] = [];
  for (const route of routes) {
    const normalizedPath = route.filePath.replace(/\\/g, '/');
    const contexts = contextsByFile.get(normalizedPath);
    if (!contexts?.length) {
      expanded.push(route);
      continue;
    }
    for (const ctx of contexts) {
      expanded.push(applyContext(route, ctx));
    }
  }
  return expanded;
}
