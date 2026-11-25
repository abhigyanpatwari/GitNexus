import { normalizeQualifiedName } from '../../utils/qualified-name.js';

export type PhpRouteReceiverKind = 'lumen' | 'laravel';

/** Detect Laravel/Lumen route files by path convention. */
export function isPhpRouteFile(filePath: string): boolean {
  return (
    filePath.endsWith('.php') && (filePath.includes('/routes/') || filePath.startsWith('routes/'))
  );
}

export interface RouteGroupContext {
  middleware: string[];
  prefix: string | null;
  namePrefix: string | null;
  controller: string | null;
  namespace: string | null;
  /** Inner `namespace` began with `\\`, resetting outer stacks (Laravel + Lumen). */
  namespaceResets?: boolean;
}

/** Lumen Router::mergeGroup / formatUsesPrefix — inner leading `\\` resets namespace. */
export function joinPhpRouteGroupNamespaces(
  outer: string | null,
  inner: string | null,
  kind: PhpRouteReceiverKind = 'lumen',
  innerResets?: boolean,
): string | null {
  if (!inner) return outer ?? null;
  const trimmedInner = inner.replace(/^\\+/, '').replace(/\\+$/, '');
  const resets = innerResets ?? inner.startsWith('\\');
  if (resets) {
    return trimmedInner || null;
  }
  if (!outer) return trimmedInner || null;
  if (kind === 'laravel') {
    return `${outer}\\${trimmedInner}`;
  }
  return `${outer.replace(/\\+$/, '')}\\${trimmedInner}`;
}

/** Lumen nested group `as`: outer + '.' + inner when both set. */
export function mergeLumenGroupAs(outer: string | null, inner: string | null): string | null {
  if (!inner) return outer;
  if (!outer) return inner;
  return `${outer}.${inner}`;
}

/** Laravel group `name` / `as` prefix: concatenation without an extra dot. */
export function mergeLaravelGroupNamePrefix(
  outer: string | null,
  inner: string | null,
): string | null {
  if (!inner) return outer;
  if (!outer) return inner;
  return `${outer}${inner}`;
}

/** Lumen mergeAsGroup — route `as` with active group `as`. */
export function mergeLumenRouteName(groupAs: string | null, routeAs: string | null): string | null {
  if (routeAs) {
    if (groupAs) return `${groupAs}.${routeAs}`;
    return routeAs;
  }
  return groupAs;
}

/** Laravel route name join (group name prefix + route segment). */
export function mergeLaravelRouteName(
  namePrefix: string | null,
  routeName: string | null,
): string | null {
  if (!routeName) return null;
  return namePrefix ? `${namePrefix}${routeName}` : routeName;
}

/** Effective context of a group stack. Treat as immutable: frames share it. */
export interface ComposedRouteGroupContext {
  readonly middleware: readonly string[];
  readonly prefix: string | null;
  readonly namePrefix: string | null;
  readonly controller: string | null;
  readonly namespace: string | null;
  readonly namespaceResets: boolean;
}

export const EMPTY_ROUTE_GROUP_CONTEXT: ComposedRouteGroupContext = Object.freeze({
  middleware: Object.freeze([]) as readonly string[],
  prefix: null,
  namePrefix: null,
  controller: null,
  namespace: null,
  namespaceResets: false,
});

/**
 * One group level on top of an already-composed parent, so each level is
 * joined once rather than the whole stack being recomposed per route.
 */
export function extendRouteGroupContext(
  parent: ComposedRouteGroupContext,
  ctx: RouteGroupContext,
  kind: PhpRouteReceiverKind,
): ComposedRouteGroupContext {
  let namespace = parent.namespace;
  let namespaceResets = parent.namespaceResets;
  if (ctx.namespaceResets) {
    namespaceResets = true;
    namespace = ctx.namespace?.replace(/^\\+|\\+$/g, '') || null;
  } else if (ctx.namespace) {
    namespace = joinPhpRouteGroupNamespaces(namespace, ctx.namespace, kind, false);
  }
  let namePrefix = parent.namePrefix;
  if (ctx.namePrefix) {
    namePrefix =
      kind === 'lumen'
        ? mergeLumenGroupAs(namePrefix, ctx.namePrefix)
        : mergeLaravelGroupNamePrefix(namePrefix, ctx.namePrefix);
  }
  return {
    middleware:
      ctx.middleware.length > 0 ? parent.middleware.concat(ctx.middleware) : parent.middleware,
    prefix: ctx.prefix
      ? parent.prefix
        ? `${parent.prefix}/${ctx.prefix}`.replace(/\/+/g, '/')
        : ctx.prefix
      : parent.prefix,
    namePrefix,
    controller: ctx.controller ?? parent.controller,
    namespace,
    namespaceResets,
  };
}

export function composeRouteGroupStack(
  stack: readonly RouteGroupContext[],
  kind: PhpRouteReceiverKind = 'laravel',
): ComposedRouteGroupContext {
  let composed = EMPTY_ROUTE_GROUP_CONTEXT;
  for (const ctx of stack) composed = extendRouteGroupContext(composed, ctx, kind);
  return composed;
}

/** Cross-file bootstrap (outer) then in-file (inner) URL prefix. */
export function mergeRoutePrefixes(outer: string | null, inner: string | null): string | null {
  if (!outer) return inner;
  if (!inner) return outer;
  return `${outer}/${inner}`.replace(/\/+/g, '/');
}

export function qualifyStringActionController(
  controllerName: string,
  composedNamespace: string | null,
  controllerAbsolute: boolean,
  aliasQualified: string | null | undefined,
): string | null {
  if (controllerAbsolute || controllerName.startsWith('\\')) {
    return normalizeQualifiedName(controllerName.replace(/^\\+/, ''));
  }
  if (composedNamespace) {
    const relative = controllerName.replace(/^\\+/, '');
    if (relative.includes('\\')) {
      const nsDots = normalizeQualifiedName(composedNamespace);
      const qualified = normalizeQualifiedName(relative);
      if (qualified === nsDots || qualified.startsWith(`${nsDots}.`)) {
        return qualified;
      }
    }
    return normalizeQualifiedName(`${composedNamespace}\\${controllerName}`);
  }
  if (controllerName.includes('\\')) {
    return normalizeQualifiedName(controllerName);
  }
  return aliasQualified ?? null;
}

/** Split middleware tokens; Lumen accepts `a|b` strings and array entries. */
export function expandMiddlewareTokens(raw: string): string[] {
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
