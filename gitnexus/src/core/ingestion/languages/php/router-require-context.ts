import type { ExtractedRoute } from '../../route-extractors/laravel.js';
import type { ExtractedRouteRequireBinding } from '../../language-provider.js';
import {
  extendRouteGroupContext,
  isPhpRouteFile,
  joinPhpRouteGroupNamespaces,
  mergeLumenRouteName,
  mergeRoutePrefixes,
  qualifyStringActionController,
} from './route-group.js';

export interface PhpRouteRequireContext {
  prefix: string | null;
  namespace: string | null;
  middleware: string[];
  namePrefix: string | null;
}

const IDENTITY_CONTEXT: PhpRouteRequireContext = Object.freeze({
  prefix: null,
  namespace: null,
  middleware: Object.freeze([]) as unknown as string[],
  namePrefix: null,
});

/**
 * Distinct contexts kept per route file. Chains of route files that each
 * require the next under several groups multiply contexts; past this bound
 * further contexts are dropped rather than growing output exponentially.
 */
const MAX_CONTEXTS_PER_FILE = 256;

const contextKey = (ctx: PhpRouteRequireContext): string =>
  JSON.stringify([ctx.prefix, ctx.namespace, ctx.namePrefix, ctx.middleware]);

function composeContext(
  outer: PhpRouteRequireContext,
  binding: ExtractedRouteRequireBinding,
): PhpRouteRequireContext {
  if (!binding.appliesContext) return outer;
  const composed = extendRouteGroupContext(
    { ...outer, controller: null, namespaceResets: false },
    {
      prefix: binding.prefix,
      namespace: binding.namespace,
      namespaceResets: binding.namespaceResets,
      middleware: binding.middleware,
      namePrefix: binding.namePrefix,
      controller: null,
    },
    'lumen',
  );
  return {
    prefix: composed.prefix,
    namespace: composed.namespace,
    middleware: [...composed.middleware],
    namePrefix: composed.namePrefix,
  };
}

const compareBindingPosition = (
  a: ExtractedRouteRequireBinding,
  b: ExtractedRouteRequireBinding,
): number => a.lineNumber - b.lineNumber || a.column - b.column;

/**
 * Map repo-relative route file paths to every group context under which they
 * may load. A bare require contributes the empty context, so a file loaded
 * both bare and inside a group keeps both. When the host is itself a route
 * file that is required somewhere, each of its contexts wraps the binding's
 * own (transitive requires). A `require_once` is dropped only when an earlier
 * unguarded require already loaded that file in the same entry walk (later in
 * that host, or inside a file the host unguardedly required first). Separate
 * entry files do not share include state. The result does not depend on the
 * order bindings arrive in. Files whose only context is the empty one are
 * omitted: their routes are unchanged.
 */
export function resolvePhpRouterRequireBindings(
  files: Iterable<string>,
  bindings: readonly ExtractedRouteRequireBinding[],
): Map<string, PhpRouteRequireContext[]> {
  const fileSet = new Set([...files].map((f) => f.replace(/\\/g, '/')));

  const byHost = new Map<string, ExtractedRouteRequireBinding[]>();
  for (const binding of bindings) {
    const host = binding.filePath.replace(/\\/g, '/');
    const list = byHost.get(host);
    if (list) list.push(binding);
    else byHost.set(host, [binding]);
  }

  type Edge = { host: string; target: string; binding: ExtractedRouteRequireBinding };
  const edges: Edge[] = [];
  const required = new Set<string>();
  const bindingTarget = (binding: ExtractedRouteRequireBinding): string | null => {
    const target = binding.requiredPath.replace(/\\/g, '/');
    if (!fileSet.has(target) || !isPhpRouteFile(target)) return null;
    return target;
  };
  /**
   * Hosts another file unguardedly requires. Those run inside the requirer's
   * `require_once` state, not as a separate entry with a fresh include set.
   */
  const inlinedHosts = new Set<string>();
  for (const list of byHost.values()) {
    for (const binding of list) {
      if (!binding.unguarded) continue;
      const target = bindingTarget(binding);
      if (target && byHost.has(target)) inlinedHosts.add(target);
    }
  }
  const skipped = new Set<ExtractedRouteRequireBinding>();
  const visited = new Set<string>();
  const walkHost = (host: string, loaded: Set<string>, stack: Set<string>) => {
    if (stack.has(host) || visited.has(host)) return;
    visited.add(host);
    stack.add(host);
    for (const binding of byHost.get(host)!.sort(compareBindingPosition)) {
      const target = bindingTarget(binding);
      if (!target) continue;
      if (binding.once && loaded.has(target)) {
        skipped.add(binding);
        continue;
      }
      if (binding.unguarded) {
        loaded.add(target);
        if (byHost.has(target)) walkHost(target, loaded, stack);
      }
    }
    stack.delete(host);
  };
  for (const host of [...byHost.keys()].sort()) {
    if (inlinedHosts.has(host) || visited.has(host)) continue;
    walkHost(host, new Set(), new Set());
  }
  for (const host of [...byHost.keys()].sort()) {
    for (const binding of byHost.get(host)!.sort(compareBindingPosition)) {
      if (skipped.has(binding)) continue;
      const target = bindingTarget(binding);
      if (!target) continue;
      edges.push({ host, target, binding });
      required.add(target);
    }
  }

  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.host);
    if (list) list.push(edge);
    else outgoing.set(edge.host, [edge]);
  }

  // A host nobody requires loads as-is; a required route file loads under
  // each of its own contexts. Each distinct context reaches a file once and
  // is pushed along that file's edges once, so the work is proportional to
  // the output. A context remembers the files already running above it: a
  // `require_once` back into one of them is skipped by PHP, and a plain
  // require back into one only terminates behind a runtime guard, so neither
  // adds a context.
  type Chain = { file: string; parent: Chain | null };
  const onChain = (chain: Chain | null, file: string): boolean => {
    for (let c = chain; c; c = c.parent) if (c.file === file) return true;
    return false;
  };
  const resolved = new Map<string, PhpRouteRequireContext[]>();
  const seen = new Map<string, Set<string>>();
  const queue: { ctx: PhpRouteRequireContext; chain: Chain }[] = [];
  const add = (edge: Edge, ctx: PhpRouteRequireContext, parent: Chain) => {
    if (onChain(parent, edge.target)) return;
    let keys = seen.get(edge.target);
    if (!keys) {
      keys = new Set();
      seen.set(edge.target, keys);
      resolved.set(edge.target, []);
    }
    if (keys.size >= MAX_CONTEXTS_PER_FILE) return;
    const key = contextKey(ctx);
    if (keys.has(key)) return;
    keys.add(key);
    resolved.get(edge.target)!.push(ctx);
    queue.push({ ctx, chain: { file: edge.target, parent } });
  };
  for (const edge of edges) {
    if (required.has(edge.host)) continue;
    add(edge, composeContext(IDENTITY_CONTEXT, edge.binding), { file: edge.host, parent: null });
  }
  for (let i = 0; i < queue.length; i++) {
    const { ctx, chain } = queue[i];
    for (const edge of outgoing.get(chain.file) ?? []) {
      add(edge, composeContext(ctx, edge.binding), chain);
    }
  }

  const identityKey = contextKey(IDENTITY_CONTEXT);
  for (const [file, contexts] of resolved) {
    if (contexts.length === 1 && contextKey(contexts[0]) === identityKey) resolved.delete(file);
  }
  return resolved;
}

function applyContext(route: ExtractedRoute, ctx: PhpRouteRequireContext): ExtractedRoute {
  if (ctx === IDENTITY_CONTEXT) return route;
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
  bindings: readonly ExtractedRouteRequireBinding[],
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
