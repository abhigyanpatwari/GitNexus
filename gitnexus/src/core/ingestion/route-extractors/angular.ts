// Angular Router route extraction (Issues #7, #43).
//
// Angular's client-side router (`@angular/router`) defines routes declaratively
// as a `Route[]` array. The two most common shapes are:
//
//   export const ROUTES: Routes = [
//     { path: 'users', component: UserListComponent },
//     { path: 'users/:id', component: UserDetailComponent },
//     { path: 'lazy', loadChildren: () => import('./lazy/lazy.module').then(m => m.LazyModule) },
//     { path: 'redirect', redirectTo: 'users' },
//     { path: 'parent', component: ParentComponent, children: [
//         { path: 'child', component: ChildComponent },
//     ]},
//   ];
//
//   @NgModule({
//     imports: [RouterModule.forRoot(ROUTES)],
//     ...
//   })
//   export class AppModule {}
//
// Or, since Angular 14, with the standalone API:
//
//   bootstrapApplication(AppComponent, {
//     providers: [provideRouter(ROUTES)],
//   });
//
// This module extracts `ExtractedRoute` records from any `.ts` file in a repo
// that imports from `@angular/router` (or contains `RouterModule`).
//
// We emit one route per route object. Client-side Angular routes have no
// HTTP method — we use `GET` as a convention so consumers can index them
// alongside server routes.

import type { ExtractedRoute } from '../workers/parse-worker.js';

/** Return true if a TypeScript file is plausibly an Angular routes file. */
export function isAngularFile(filePath: string, content: string): boolean {
  // Cheap content check first — the parse-worker only routes Angular files
  // into the extractor, and this lets the extractor be a no-op for files
  // that don't use the router.
  if (!/\.tsx?$/.test(filePath)) return false;
  // A common gotcha: terser/minified outputs and random TS files
  // occasionally mention "Routes" as an identifier. We require at least one
  // stronger signal: an import from `@angular/router` or the `RouterModule`
  // identifier (which is the canonical surface for the legacy and modern APIs).
  return content.includes('RouterModule')
    || content.includes('@angular/router')
    || content.includes('provideRouter');
}

interface RouteNode {
  path?: string;
  redirectTo?: string;
  loadChildren?: boolean;
  children?: RouteNode[];
  component?: string;
}

/**
 * Public entry point: walk a parsed tree-sitter TypeScript AST and extract
 * Angular route definitions.
 *
 * The two patterns recognized:
 *   1. `RouterModule.forRoot(ROUTES)` / `RouterModule.forChild(ROUTES)` —
 *      the first argument is a route config array (either inline or by
 *      reference to a `const ROUTES = [...]` declaration).
 *   2. Standalone `provideRouter(ROUTES)` calls.
 *   3. Direct route config arrays assigned to a `const` variable — useful
 *      when the wiring module imports the array under a different name.
 *
 * Returns an empty array for non-Angular files.
 */
export function extractAngularRoutes(tree: any, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  if (!tree || !tree.rootNode) return routes;

  const controllerName = inferControllerName(filePath);

  // Track array nodes we've already emitted routes for, so the two
  // walkers (forRoot / forChild / provideRouter vs. direct const
  // arrays) don't duplicate routes when a `const ROUTES = [...]` is
  // both referenced by `forRoot(ROUTES)` and is itself a Routes array.
  const emittedFrom = new WeakSet<object>();

  // Pattern A & B: pull routes from `forRoot` / `forChild` / `provideRouter`
  // call sites by walking the tree for matching call_expressions.
  walkForRootCalls(tree.rootNode, routes, controllerName, filePath, emittedFrom);

  // Pattern C: direct array literals. If the file contains a `Routes` (or
  // `Route[]`) typed array, walk it directly so we don't depend on the
  // import name (ROUTES, appRoutes, AppRoutes, …).
  walkDirectRouteArrays(tree.rootNode, routes, controllerName, filePath, emittedFrom);

  return routes;
}

function inferControllerName(filePath: string): string | null {
  // Heuristic: `app.routes.ts` → "AppModule". Routing module files
  // (e.g. `app-routing.module.ts`, `feature-routing.module.ts`) are
  // typically named after their feature module, not the application
  // shell, so we leave them as `null` to avoid guessing.
  const base = filePath.split('/').pop() ?? '';
  if (base === 'app.routes.ts') {
    return 'AppModule';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/**
 * Find every `RouterModule.forRoot(...)` / `RouterModule.forChild(...)` /
 * `provideRouter(...)` call and extract its route array.
 */
function walkForRootCalls(
  root: any,
  routes: ExtractedRoute[],
  controllerName: string | null,
  filePath: string,
  emittedFrom: WeakSet<object>,
): void {
  walk(root, (node) => {
    if (node.type !== 'call_expression') return;
    const func = node.childForFieldName?.('function') ?? node.children?.[0];
    if (!func || func.type !== 'member_expression') return;

    const prop = func.childForFieldName?.('property') ?? func.children?.[func.childCount - 1];
    if (!prop || prop.type !== 'property_identifier') return;
    const method = prop.text;
    if (method !== 'forRoot' && method !== 'forChild' && method !== 'provideRouter') return;

    const obj = func.childForFieldName?.('object') ?? func.children?.[0];
    if (method === 'provideRouter') {
      // provideRouter is a bare call — accept it as-is.
    } else {
      // Must be `RouterModule.forRoot/forChild` — `obj` is an identifier.
      if (!obj || obj.type !== 'identifier') return;
      if (obj.text !== 'RouterModule') return;
    }

    const args = node.childForFieldName?.('arguments') ?? node.children?.find((c: any) => c.type === 'arguments');
    if (!args) return;
    const routeArray = findFirstRouteArrayArg(args);
    if (!routeArray) return;
    if (emittedFrom.has(routeArray)) return;
    emittedFrom.add(routeArray);
    flattenRouteArray(routeArray, [], routes, controllerName, filePath);
  });
}

/**
 * Find a top-level `const FOO = [...]` whose value is an array of route
 * objects (objects containing a `path` or `redirectTo` or `loadChildren`
 * property). We don't need the binding to be referenced — emitting routes
 * from a routes file is always safe.
 */
function walkDirectRouteArrays(
  root: any,
  routes: ExtractedRoute[],
  controllerName: string | null,
  filePath: string,
  emittedFrom: WeakSet<object>,
): void {
  walk(root, (node) => {
    if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') return;
    for (const decl of node.namedChildren ?? []) {
      if (decl.type !== 'variable_declarator') continue;
      const value = decl.childForFieldName?.('value') ?? decl.children?.[1];
      if (!value || value.type !== 'array') continue;
      if (emittedFrom.has(value)) continue;
      if (!looksLikeRouteArray(value)) continue;
      emittedFrom.add(value);
      flattenRouteArray(value, [], routes, controllerName, filePath);
    }
  });
}

function looksLikeRouteArray(arr: any): boolean {
  // A route array is `[ {...}, {...} ]` where every element is an object
  // with at least one of {path, redirectTo, loadChildren}. We accept the
  // array if the first object has one of those keys — arrays of route
  // objects are homogeneous.
  const first = arr.namedChildren?.find((c: any) => c.type === 'object');
  if (!first) return false;
  return hasRouteKey(first);
}

function hasRouteKey(obj: any): boolean {
  for (const prop of obj.namedChildren ?? []) {
    if (prop.type !== 'pair' && prop.type !== 'shorthand_property_identifier_pattern') continue;
    const keyNode = prop.childForFieldName?.('key') ?? prop.children?.[0];
    if (!keyNode) continue;
    const key = keyNode.text;
    if (key === 'path' || key === 'redirectTo' || key === 'loadChildren' || key === 'children') {
      return true;
    }
  }
  return false;
}

function findFirstRouteArrayArg(argsNode: any): any | null {
  for (const arg of argsNode.namedChildren ?? []) {
    // Direct array literal
    if (arg.type === 'array') {
      if (looksLikeRouteArray(arg)) return arg;
      continue;
    }
    // Identifier reference — pull the array from the const declaration.
    if (arg.type === 'identifier') {
      const resolved = resolveConstArray(arg);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Find the variable declaration for an identifier in the same file and
 * return its array-literal value, if any.
 */
function resolveConstArray(identifier: any): any | null {
  const name = identifier.text;
  let found: any = null;
  // Walk up to the program root, then DFS siblings.
  let top: any = identifier;
  while (top.parent) top = top.parent;
  walk(top, (node: any) => {
    if (found) return;
    if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') return;
    for (const decl of node.namedChildren ?? []) {
      if (decl.type !== 'variable_declarator') continue;
      const declName = decl.childForFieldName?.('name') ?? decl.children?.[0];
      if (!declName || declName.text !== name) continue;
      const value = decl.childForFieldName?.('value') ?? decl.children?.[1];
      if (value && value.type === 'array') {
        found = value;
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Route emission
// ---------------------------------------------------------------------------

/**
 * Recursively flatten a route array. For each route object, emit a single
 * `ExtractedRoute`. If the object has a `children: [...]` array, recurse
 * with the parent path prepended.
 *
 * @param parentPath  segments accumulated from ancestor route objects
 */
function flattenRouteArray(
  arr: any,
  parentPath: string[],
  routes: ExtractedRoute[],
  controllerName: string | null,
  filePath: string,
): void {
  for (const routeObj of arr.namedChildren ?? []) {
    if (routeObj.type !== 'object') continue;
    const routeNode = readRouteObject(routeObj);
    if (!routeNode) continue;

    const segment = routeNode.path ?? '';
    const fullPath = joinAngularPaths(parentPath, segment);

    // If this route only exists to host children, skip the parent
    // emission (Angular convention) — emit children with the parent
    // prepended instead.
    const isLeaf = !routeNode.children || routeNode.children.length === 0;

    if (isLeaf) {
      const routePath = annotateRoute(fullPath, routeNode);
      if (routePath !== null) {
        routes.push({
          filePath,
          httpMethod: 'GET',
          routePath,
          controllerName,
          methodName: null,
          middleware: [],
          prefix: null,
          lineNumber: routeObj.startPosition?.row ?? 0,
          isControllerClass: false,
          isInherited: false,
        });
      }
    } else {
      // Always emit the parent as a route too (matches Spring/Express
      // behaviour where every annotated handler is a route), and then
      // recurse into children.
      const routePath = annotateRoute(fullPath, routeNode);
      if (routePath !== null) {
        routes.push({
          filePath,
          httpMethod: 'GET',
          routePath,
          controllerName,
          methodName: null,
          middleware: [],
          prefix: null,
          lineNumber: routeObj.startPosition?.row ?? 0,
          isControllerClass: false,
          isInherited: false,
        });
      }
      // Find the children array literal in the original AST node so we
      // can recurse without re-parsing the synthesized object.
      const childrenArr = findChildrenArray(routeObj);
      if (childrenArr) {
        flattenRouteArray(childrenArr, [...parentPath, segment], routes, controllerName, filePath);
      }
    }
  }
}

function readRouteObject(obj: any): RouteNode | null {
  const result: RouteNode = {};
  let hasAnyRouteKey = false;
  for (const prop of obj.namedChildren ?? []) {
    if (prop.type !== 'pair') continue;
    const keyNode = prop.childForFieldName?.('key') ?? prop.children?.[0];
    const valueNode = prop.childForFieldName?.('value') ?? prop.children?.[1];
    if (!keyNode || !valueNode) continue;
    const key = keyNode.text;

    if (key === 'path') {
      const v = unquoteString(valueNode);
      if (v !== null) {
        result.path = v;
        hasAnyRouteKey = true;
      }
    } else if (key === 'redirectTo') {
      const v = unquoteString(valueNode);
      if (v !== null) {
        result.redirectTo = v;
        hasAnyRouteKey = true;
      }
    } else if (key === 'loadChildren') {
      // Arrow / function form: () => import('...').then(m => m.Mod)
      // or shorthand string form: 'lazy/lazy.module#LazyModule'
      result.loadChildren = true;
      hasAnyRouteKey = true;
    } else if (key === 'children') {
      if (valueNode.type === 'array') {
        result.children = [{ __rawChildren: valueNode } as any];
        hasAnyRouteKey = true;
      }
    }
  }
  return hasAnyRouteKey ? result : null;
}

function findChildrenArray(obj: any): any | null {
  for (const prop of obj.namedChildren ?? []) {
    if (prop.type !== 'pair') continue;
    const keyNode = prop.childForFieldName?.('key') ?? prop.children?.[0];
    if (!keyNode || keyNode.text !== 'children') continue;
    const valueNode = prop.childForFieldName?.('value') ?? prop.children?.[1];
    if (valueNode && valueNode.type === 'array') return valueNode;
  }
  return null;
}

/**
 * Annotate a route path with metadata about lazy / redirect variants so
 * the downstream consumer can distinguish them.
 *
 *   { path: 'lazy', loadChildren: ... }    → "lazy (lazy)"
 *   { path: 'redirect', redirectTo: ... }  → "redirect (redirect:users)"
 *   { path: 'users' }                      → "users"
 */
function annotateRoute(fullPath: string, route: RouteNode): string | null {
  if (route.loadChildren) {
    return `${fullPath} (lazy)`;
  }
  if (route.redirectTo) {
    return `${fullPath} (redirect:${route.redirectTo})`;
  }
  return fullPath;
}

function joinAngularPaths(parentSegments: string[], segment: string): string {
  const parts = [...parentSegments, segment].filter((p) => p !== '');
  let p = '/' + parts.join('/');
  // Normalize multiple slashes (defensive — shouldn't happen).
  p = p.replace(/\/{2,}/g, '/');
  return p === '' ? '/' : p;
}

function unquoteString(node: any): string | null {
  if (!node) return null;
  if (node.type === 'string' || node.type === 'string_literal') {
    const raw = node.text;
    // Strip template-string backticks if any leaked through
    let s = raw;
    if (s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1);
    // Strip surrounding " or '
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generic tree walker
// ---------------------------------------------------------------------------

function walk(node: any, visit: (n: any) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}
