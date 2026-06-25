/**
 * Shared Spring route-annotation primitives.
 *
 * These are the low-level building blocks the two Spring route extractors —
 * the ingestion-layer `route-extractors/spring.ts` (produces graph `Route`
 * nodes) and the group-layer `group/extractors/http-patterns/java.ts`
 * (produces cross-repo HTTP contracts) — would otherwise each maintain
 * independently. Centralising the annotation→method map, the enclosing-class
 * lookup, and the route-key filter keeps those semantics in one place so the
 * two extractors can't drift apart.
 *
 * This module lives in `ingestion/` (the lower layer); the group layer imports
 * from it, matching the existing `group → ingestion` dependency direction
 * (e.g. `group/extractors/include-extractor.ts` already imports
 * `ingestion/import-resolvers/utils.ts`). It MUST NOT import anything from
 * `group/` to avoid a dependency cycle.
 */

import type Parser from 'tree-sitter';

/**
 * Spring shortcut method-annotation → HTTP verb.
 *
 * `@RequestMapping` is intentionally absent: on a method it carries no implicit
 * verb (the verb lives in its `method = RequestMethod.X` attribute), and on a
 * class it is a URL prefix rather than a route. Callers handle `@RequestMapping`
 * separately.
 */
export const METHOD_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/**
 * A named annotation argument contributes a route only when its member key is
 * `path` or `value`; a positional argument (no key node) always qualifies.
 * Drops Spring's non-route string attributes (`produces`, `consumes`,
 * `headers`, `name`, `params`) that would otherwise be mis-read as routes.
 */
export function isRouteMemberKey(keyNode: Parser.SyntaxNode | undefined): boolean {
  if (!keyNode) return true;
  return keyNode.text === 'path' || keyNode.text === 'value';
}

/**
 * Find the nearest enclosing `class_declaration` ancestor for a node, or null
 * if the node is top-level. Tree-sitter's `SyntaxNode.parent` walks one level
 * at a time.
 */
export function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Find the nearest enclosing Java type declaration (class OR interface) for a
 * node, reporting its kind. Used by the ingestion route extractor to tell an
 * interface-declared `@*Mapping` (handled by the cross-file inheritance pass,
 * #2288) apart from a concrete class route, and by the type collector.
 */
export function findEnclosingType(
  node: Parser.SyntaxNode,
): { node: Parser.SyntaxNode; kind: 'class' | 'interface' } | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration') return { node: cur, kind: 'class' };
    if (cur.type === 'interface_declaration') return { node: cur, kind: 'interface' };
    cur = cur.parent;
  }
  return null;
}

/**
 * Strip enclosing quotes from a tree-sitter string-literal node's text.
 * Handles single / double / template (backtick) quotes and triple-quoted
 * strings. Mirrors the safer semantics of the group layer's `unquoteLiteral`:
 * returns `null` for empty / nullish input so callers can uniformly skip
 * captures whose value is missing, and returns the text unchanged when it
 * carries no recognisable surrounding quotes (some grammars expose string
 * content without quotes already).
 */
export function unquoteSpringLiteral(raw: string): string | null {
  if (!raw) return null;

  if (
    (raw.startsWith('"""') && raw.endsWith('"""')) ||
    (raw.startsWith("'''") && raw.endsWith("'''"))
  ) {
    return raw.slice(3, -3);
  }

  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' || first === "'" || first === '`') && last === first && raw.length >= 2) {
    return raw.slice(1, -1);
  }

  return raw;
}

/**
 * Join a class/interface-level prefix and a method-level path into a single
 * URL path: strip leading/trailing slashes on the prefix and leading slashes
 * on the method path, then ensure exactly one slash between them.
 *
 * Lives here (the lower shared layer) so the ingestion route extractor and the
 * group-layer Spring/Kotlin plugins join prefixes identically; the group
 * `spring-consumer-shared.ts` re-exports it for its existing importers.
 */
export function joinPath(prefix: string, methodPath: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanSub = methodPath.replace(/^\/+/, '');
  if (!cleanPrefix) return `/${cleanSub}`;
  return `/${cleanPrefix}/${cleanSub}`;
}

/**
 * Join a controller's own class prefix with a route inherited from an interface
 * (interface-based controllers, #1743). The inherited path already has the
 * interface's own class prefix (`inheritedOwnerPrefix`) baked in; when the
 * controller repeats that same prefix we must NOT prepend it twice (#2057).
 */
export function joinInheritedSpringPath(
  controllerPrefix: string,
  inheritedPath: string,
  inheritedOwnerPrefix = '',
): string {
  const joined = joinPath(controllerPrefix, inheritedPath);
  const cleanPrefix = controllerPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanOwnerPrefix = inheritedOwnerPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanInherited = inheritedPath.replace(/^\/+/, '');
  if (!cleanPrefix) return joined;
  if (
    cleanPrefix === cleanOwnerPrefix &&
    (cleanInherited === cleanPrefix || cleanInherited.startsWith(`${cleanPrefix}/`))
  ) {
    return `/${cleanInherited}`;
  }
  return joined;
}

/**
 * Language-agnostic view of a Spring class/interface that each extractor's
 * grammar-specific collector produces. The interface-based-controller
 * inheritance algorithm (`resolveInheritedSpringRoutes`) operates only on this
 * shape, so the ingestion route extractor and the group Java/Kotlin plugins
 * share one algorithm and cannot drift.
 *
 * `methods[].routes` carry only `{ method, path }` — the interface's own class
 * prefix is applied *inside* `resolveInheritedSpringRoutes` (it is not part of
 * the collector's output).
 */
export interface SharedSpringType {
  filePath: string;
  kind: 'class' | 'interface';
  name: string;
  /** Class-level `@RequestMapping` prefixes — one per array element. */
  classPrefixes: string[];
  implementedInterfaces: string[];
  isController: boolean;
  methods: Array<{ name: string; routes: Array<{ method: string; path: string }> }>;
}

/** One provider route a concrete controller inherits from an interface. */
interface InheritedSpringRoute {
  /** File of the implementing controller (where the route should be attributed). */
  filePath: string;
  /** Name of the controller method that inherits the route. */
  methodName: string;
  method: string;
  path: string;
}

/**
 * An interface route with its own class prefix already baked in. `ownerPrefix`
 * records that prefix so the controller side avoids doubling it (#2057).
 */
interface IntermediateRoute {
  method: string;
  path: string;
  ownerPrefix: string;
}

/**
 * Resolve interface-based-controller provider routes (#1743): a concrete
 * `@RestController`/`@Controller` class inherits the `@(Get|...)Mapping` routes
 * declared on the interface it implements. Pure and language-agnostic — shared
 * by the ingestion route extractor and the group Java/Kotlin plugins so all
 * three emit the same inherited routes.
 *
 * An interface name that resolves to two distinct interfaces is ambiguous and
 * its routes are dropped (the `null` marker). The controller's own class
 * prefix(es) cross-product the inherited routes; `joinInheritedSpringPath`
 * avoids doubling a prefix the interface already baked in (#2057). Duplicate
 * `(method, path)` results per controller method are de-duped.
 */
export function resolveInheritedSpringRoutes(types: SharedSpringType[]): InheritedSpringRoute[] {
  // interface name → (method name → routes). `null` marks an ambiguous
  // (duplicated) interface name. `IntermediateRoute` is declared at module scope.
  const interfaceRoutes = new Map<string, Map<string, IntermediateRoute[]> | null>();
  for (const type of types) {
    if (type.kind !== 'interface') continue;
    if (interfaceRoutes.has(type.name)) {
      interfaceRoutes.set(type.name, null);
      continue;
    }
    const prefixes = type.classPrefixes.length ? type.classPrefixes : [''];
    const methodMap = new Map<string, IntermediateRoute[]>();
    for (const method of type.methods) {
      // Cross-product the interface's class prefixes with each method route, so a
      // multi-element `@RequestMapping(["/a","/b"])` interface yields N bindings.
      const routes = method.routes.flatMap((route) =>
        prefixes.map((prefix) => ({
          method: route.method,
          path: prefix ? joinPath(prefix, route.path) : route.path,
          ownerPrefix: prefix,
        })),
      );
      if (routes.length > 0) methodMap.set(method.name, routes);
    }
    interfaceRoutes.set(type.name, methodMap);
  }

  const out: InheritedSpringRoute[] = [];
  for (const type of types) {
    if (type.kind !== 'class' || !type.isController) continue;
    // Cross-product the controller's own class prefixes with each inherited
    // route; `['']` keeps the common no-prefix controller emitting the
    // interface path unchanged.
    const controllerPrefixes = type.classPrefixes.length ? type.classPrefixes : [''];
    for (const method of type.methods) {
      if (method.routes.length > 0) continue; // own @*Mapping → already a provider
      const inherited = type.implementedInterfaces.flatMap((iface) => {
        const routeMap = interfaceRoutes.get(iface);
        if (!routeMap) return [];
        const routes = routeMap.get(method.name) ?? [];
        return routes.flatMap((route) =>
          controllerPrefixes.map((controllerPrefix) => ({
            method: route.method,
            path: joinInheritedSpringPath(controllerPrefix, route.path, route.ownerPrefix),
          })),
        );
      });
      const seen = new Set<string>();
      for (const route of inherited) {
        const key = `${route.method} ${route.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          filePath: type.filePath,
          methodName: method.name,
          method: route.method,
          path: route.path,
        });
      }
    }
  }

  return out;
}
