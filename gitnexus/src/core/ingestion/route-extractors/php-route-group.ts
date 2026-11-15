import { normalizeQualifiedName } from '../utils/qualified-name.js';

export type PhpRouteReceiverKind = 'lumen' | 'laravel';

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

export function composeRouteGroupStack(
  stack: readonly RouteGroupContext[],
  kind: PhpRouteReceiverKind = 'laravel',
): {
  middleware: string[];
  prefix: string | null;
  namePrefix: string | null;
  controller: string | null;
  namespace: string | null;
  namespaceResets: boolean;
} {
  const middleware: string[] = [];
  let prefix: string | null = null;
  let namePrefix: string | null = null;
  let controller: string | null = null;
  let namespace: string | null = null;
  let namespaceResets = false;
  for (const ctx of stack) {
    middleware.push(...ctx.middleware);
    if (ctx.prefix) prefix = prefix ? `${prefix}/${ctx.prefix}`.replace(/\/+/g, '/') : ctx.prefix;
    if (ctx.namePrefix) {
      namePrefix =
        kind === 'lumen'
          ? mergeLumenGroupAs(namePrefix, ctx.namePrefix)
          : mergeLaravelGroupNamePrefix(namePrefix, ctx.namePrefix);
    }
    if (ctx.controller) controller = ctx.controller;
    if (ctx.namespaceResets) {
      namespaceResets = true;
      namespace = ctx.namespace?.replace(/^\\+|\\+$/g, '') || null;
    } else if (ctx.namespace) {
      namespace = joinPhpRouteGroupNamespaces(namespace, ctx.namespace, kind, false);
    }
  }
  return { middleware, prefix, namePrefix, controller, namespace, namespaceResets };
}

/** Cross-file bootstrap (outer) then in-file (inner) URL prefix. */
export function mergeRoutePrefixes(outer: string | null, inner: string | null): string | null {
  if (!outer) return inner;
  if (!inner) return outer;
  return `${outer}/${inner}`.replace(/\/+/g, '/');
}

/** Cross-file Lumen-style group `as` stacking. */
export function mergeCrossFileGroupAs(outer: string | null, inner: string | null): string | null {
  return mergeLumenGroupAs(outer, inner);
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
