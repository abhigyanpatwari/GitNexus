import type { LanguageProvider } from '../language-provider.js';
import { resolveFrameworkRouteFacts } from './framework-route-resolver.js';
import { normalizeExtractedRoutePath } from './route-path.js';
import type {
  FrameworkImportResolver,
  FrameworkRoute,
  FrameworkRouteFacts,
  ResolvedFrameworkRoutes,
} from './framework-route-types.js';

/** Each connected mount component either finishes or contributes no routes. */
export const FRAMEWORK_MOUNT_EXPANSION_LIMIT = 10_000;

export function composeFrameworkRoutePaths(
  resolved: ResolvedFrameworkRoutes,
  expansionLimit = FRAMEWORK_MOUNT_EXPANSION_LIMIT,
): FrameworkRoute[] {
  const outgoing = new Map<string, typeof resolved.mounts>();
  const neighbors = new Map<string, Set<string>>();
  const incoming = new Set<string>();
  for (const mount of resolved.mounts) {
    incoming.add(mount.childId); // Dynamic mounts also suppress standalone fallback.
    const edges = outgoing.get(mount.parentId) ?? [];
    edges.push(mount);
    outgoing.set(mount.parentId, edges);
    for (const [from, to] of [
      [mount.parentId, mount.childId],
      [mount.childId, mount.parentId],
    ]) {
      const adjacent = neighbors.get(from) ?? new Set<string>();
      adjacent.add(to);
      neighbors.set(from, adjacent);
    }
  }
  const prefixes = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const allocation of resolved.allocations) {
    if (seen.has(allocation.id) || allocation.kind === 'hono') continue;
    const component = new Set<string>();
    const pending = [allocation.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (component.has(id)) continue;
      component.add(id);
      seen.add(id);
      for (const neighbor of neighbors.get(id) ?? []) pending.push(neighbor);
    }
    const roots = [...component].filter((id) => !incoming.has(id)).sort();
    const componentPrefixes = new Map<string, Set<string>>();
    const stack = roots.map((id) => ({ id, prefix: '', visiting: new Set<string>() }));
    let steps = 0;
    let exhausted = false;
    while (stack.length) {
      if (++steps > expansionLimit) {
        exhausted = true;
        break;
      }
      const current = stack.pop()!;
      if (current.visiting.has(current.id)) continue;
      const paths = componentPrefixes.get(current.id) ?? new Set<string>();
      paths.add(current.prefix);
      componentPrefixes.set(current.id, paths);
      const visiting = new Set(current.visiting).add(current.id);
      for (const mount of outgoing.get(current.id) ?? []) {
        if (visiting.has(mount.childId)) continue;
        for (const prefix of mount.prefixes ?? []) {
          // Count queued work too, so a large path array cannot allocate an
          // unbounded frontier before the next expansion checks its budget.
          if (steps + stack.length >= expansionLimit) {
            exhausted = true;
            break;
          }
          stack.push({
            id: mount.childId,
            prefix: normalizeExtractedRoutePath(prefix, current.prefix),
            visiting,
          });
        }
        if (exhausted) break;
      }
      if (exhausted) break;
    }
    if (!exhausted) for (const [id, paths] of componentPrefixes) prefixes.set(id, paths);
  }
  const routes = new Map<string, FrameworkRoute>();
  for (const registration of resolved.registrations) {
    const paths =
      registration.framework === 'hono' ? [''] : (prefixes.get(registration.receiverId) ?? []);
    for (const prefix of paths) {
      const route = {
        ...registration.route,
        routePath: normalizeExtractedRoutePath(registration.route.routePath, prefix),
      };
      const key = JSON.stringify([
        route.filePath,
        route.lineNumber,
        route.httpMethod,
        route.routePath,
        route.handlerName,
      ]);
      routes.set(key, route);
    }
  }
  return [...routes.values()].sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) ||
      left.lineNumber - right.lineNumber ||
      left.routePath.localeCompare(right.routePath) ||
      (left.httpMethod ?? '').localeCompare(right.httpMethod ?? ''),
  );
}

/** Shared ingestion/group entry point. Inputs are already parsed provider facts. */
export function resolveFrameworkRoutePaths(
  files: readonly FrameworkRouteFacts[],
  resolveImportTargets: FrameworkImportResolver,
): FrameworkRoute[] {
  return composeFrameworkRoutePaths(resolveFrameworkRouteFacts(files, resolveImportTargets));
}

/** The same function identity intentionally groups JS/TS/TSX facts together. */
export const resolveProjectFrameworkRouteFacts: NonNullable<
  LanguageProvider['resolveRouteFacts']
> = (files, context) =>
  resolveFrameworkRoutePaths(
    files.map(({ facts }) => facts as FrameworkRouteFacts),
    context.resolveImportTargets,
  );
