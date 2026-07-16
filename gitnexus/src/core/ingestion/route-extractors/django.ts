import type Parser from 'tree-sitter';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { extractStringContent, type SyntaxNode } from '../utils/ast-helpers.js';
import type { ExtractedRoute } from './laravel.js';
import { logger } from '../../logger.js';

interface DjangoRouteContext {
  prefix: string | null;
}

interface WalkFrame {
  node: SyntaxNode;
  routeCtx: DjangoRouteContext;
  currentFilePath: string;
  depth: number;
}

const DJANGO_ROUTE_FUNCTIONS = new Set(['path', 're_path', 'url']);
const DJANGO_INCLUDE_FUNCTION = 'include';
const MAX_INCLUDE_DEPTH = 8;

// Wrapper calls whose first list/tuple argument is itself a urlpatterns list
// (e.g. DRF's `format_suffix_patterns([...])`, `i18n_patterns(...)`,
// `staticfiles_urlpatterns()`). We descend into their list-typed arguments.
const URLPATTERNS_WRAPPER_FUNCTIONS = new Set([
  'format_suffix_patterns',
  'staticfiles_urlpatterns',
  'i18n_patterns',
]);

function modulePathToFilePath(modulePath: string): string {
  return modulePath.replace(/\./g, '/');
}

export type DjangoFileReader = (relativePath: string) => string | null;

function extractStringArg(argsNode: SyntaxNode | null): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === '(' || child.type === ')' || child.type === ',') continue;
    if (child.type === 'string') {
      return extractStringContent(child);
    }
    if (child.type === 'binary_operator') {
      let concat = '';
      for (const part of child.children ?? []) {
        if (part.type === 'string') {
          const s = extractStringContent(part);
          if (s !== null) concat += s;
        }
      }
      if (concat) return concat;
    }
  }
  return null;
}

function extractViewTarget(argsNode: SyntaxNode | null): {
  viewName: string | null;
  viewCall: string | null;
} {
  if (!argsNode) return { viewName: null, viewCall: null };
  const positionalArgs: SyntaxNode[] = [];
  for (const child of argsNode.children ?? []) {
    if (child.type === '(' || child.type === ')' || child.type === ',') continue;
    positionalArgs.push(child);
  }
  const viewNode = positionalArgs[1];
  if (!viewNode) return { viewName: null, viewCall: null };
  if (viewNode.type === 'attribute') return { viewName: viewNode.text, viewCall: null };
  if (viewNode.type === 'call') return { viewName: null, viewCall: viewNode.text };
  if (viewNode.type === 'identifier') return { viewName: viewNode.text, viewCall: null };
  if (viewNode.type === 'string')
    return { viewName: extractStringContent(viewNode), viewCall: null };
  return { viewName: null, viewCall: null };
}

function inferHttpMethod(viewName: string | null): string {
  if (!viewName) return '*';
  const lower = viewName.toLowerCase();
  const m = lower.match(/\.(get|post|put|patch|delete|head|options)(_|$)/);
  if (m) {
    return m[1].toUpperCase();
  }
  return '*';
}

/**
 * Collect the list/tuple container node(s) that hold route entries from a
 * `urlpatterns` right-hand side. Handles the common non-literal shapes:
 *   - `urlpatterns = [...]`              → the list
 *   - `urlpatterns = (...)`              → the tuple
 *   - `urlpatterns = a + b`              → both operands (concatenation)
 *   - `urlpatterns = wrapper([...])`     → the wrapper's list argument
 * Inherently-dynamic shapes (`router.urls`, comprehensions, bare names) yield
 * nothing — they cannot be resolved statically.
 */
function collectUrlpatternContainers(node: SyntaxNode, out: SyntaxNode[]): void {
  switch (node.type) {
    case 'list':
    case 'tuple':
      out.push(node);
      return;
    case 'binary_operator':
      // `a + b` concatenation — descend into both operands.
      for (const child of node.children ?? []) collectUrlpatternContainers(child, out);
      return;
    case 'call': {
      const fn = getCallFuncName(node);
      if (fn && URLPATTERNS_WRAPPER_FUNCTIONS.has(fn)) {
        const args = node.childForFieldName?.('arguments') ?? null;
        for (const child of args?.children ?? []) collectUrlpatternContainers(child, out);
      }
      return;
    }
    default:
      return;
  }
}

function findUrlpatternsLists(rootNode: SyntaxNode): SyntaxNode[] {
  const assignmentNodes: SyntaxNode[] = [];
  _collectAssignments(rootNode, assignmentNodes);
  const lists: SyntaxNode[] = [];
  for (const node of assignmentNodes) {
    const left = node.childForFieldName?.('left') ?? node.children?.[0] ?? null;
    if (left?.type === 'identifier' && left.text === 'urlpatterns') {
      const right = node.childForFieldName?.('right') ?? node.children?.[2] ?? null;
      if (!right) continue;
      const before = lists.length;
      collectUrlpatternContainers(right, lists);
      if (lists.length === before && (right.type === 'attribute' || right.type === 'identifier')) {
        // Dynamically-built urlpatterns (e.g. DRF `router.urls`) can't be
        // resolved statically — surface it so the silent-zero case is visible.
        logger.debug(`Django: skipping non-static urlpatterns (${right.type}: ${right.text})`);
      }
    }
  }
  return lists;
}

function _collectAssignments(node: SyntaxNode, out: SyntaxNode[]): void {
  if (node.type === 'assignment' || node.type === 'augmented_assignment') {
    out.push(node);
  }
  for (const child of node.children ?? []) {
    _collectAssignments(child, out);
  }
}

function emitDjangoRoute(
  callNode: SyntaxNode,
  filePath: string,
  ctx: DjangoRouteContext,
): ExtractedRoute {
  const argsNode = callNode.childForFieldName?.('arguments') ?? null;
  const routePath = extractStringArg(argsNode);

  const { viewName, viewCall } = extractViewTarget(argsNode);
  const httpMethod = inferHttpMethod(viewName);

  let routeName: string | null = null;
  if (argsNode) {
    for (let i = 0; i < argsNode.children.length; i++) {
      const child = argsNode.children[i];
      if (child.type === 'keyword_argument' && child.childForFieldName?.('name')?.text === 'name') {
        const valueNode = child.childForFieldName?.('value');
        if (valueNode?.type === 'string') {
          routeName = extractStringContent(valueNode);
        }
      }
    }
  }

  return {
    filePath,
    httpMethod,
    routePath,
    routeName,
    controllerName: viewName ?? viewCall,
    methodName: null,
    middleware: [],
    prefix: ctx.prefix,
    lineNumber: callNode.startPosition.row,
  };
}

function getIncludeModulePath(callNode: SyntaxNode): string | null {
  const funcName =
    callNode.childForFieldName?.('function')?.text ??
    callNode.children?.find((c) => c.type === 'identifier')?.text;
  if (funcName !== DJANGO_INCLUDE_FUNCTION) return null;
  const argsNode = callNode.childForFieldName?.('arguments');
  if (!argsNode) return null;

  const modulePath = extractStringArg(argsNode);
  if (modulePath) return modulePath;

  for (const child of argsNode.children ?? []) {
    if (child.type === '(' || child.type === ')' || child.type === ',') continue;
    if (child.type === 'tuple' || child.type === 'parenthesized_expression') {
      for (const inner of child.children ?? []) {
        if (inner.type === '(' || inner.type === ')' || inner.type === ',') continue;
        if (inner.type === 'string') return extractStringContent(inner);
      }
    }
  }
  return null;
}

function makePrefix(parentPrefix: string | null, childPrefix: string | null): string | null {
  if (!childPrefix) return parentPrefix;
  if (!parentPrefix) return childPrefix;
  return `${parentPrefix}/${childPrefix}`.replace(/\/+/g, '/');
}

/**
 * Recursion-guard key. A urlconf file is walked once *per accumulated prefix*,
 * so a urlconf `include()`d under two different prefixes (a "diamond" — e.g.
 * the same app mounted at `/v1/` and `/v2/`) emits routes for both mounts,
 * while a genuine cycle (same file + same prefix) still terminates. `null` and
 * `''` collapse to the same key so a no-prefix re-entry is treated as a cycle.
 */
function includeVisitKey(filePath: string, prefix: string | null): string {
  return `${filePath}\u0000${prefix ?? ''}`;
}

function getCallFuncName(node: SyntaxNode): string | null {
  return (
    node.childForFieldName?.('function')?.text ??
    node.children?.find((c) => c.type === 'identifier')?.text ??
    null
  );
}

/**
 * Find the Django project root for `startFilePath` — the nearest ancestor
 * directory that contains a `manage.py`. Django resolves `include('app.urls')`
 * as an absolute import from this directory (it is the entry on `sys.path`), so
 * knowing it lets us resolve includes unambiguously even when an unrelated
 * `app/urls.py` exists at the repo root (the monorepo wrong-app hazard).
 * Returns the project-root directory (possibly `''` for a repo-root project),
 * or `null` when no `manage.py` ancestor is readable.
 */
function findDjangoProjectRoot(
  startFilePath: string,
  readFile: DjangoFileReader | null | undefined,
): string | null {
  if (!readFile) return null;
  let dir = startFilePath.includes('/')
    ? startFilePath.substring(0, startFilePath.lastIndexOf('/'))
    : '';
  for (;;) {
    const candidate = dir ? `${dir}/manage.py` : 'manage.py';
    if (readFile(candidate) !== null) return dir;
    if (!dir) return null;
    const sep = dir.lastIndexOf('/');
    dir = sep < 0 ? '' : dir.substring(0, sep);
  }
}

/**
 * Given a Django dotted module path like `app.submodule.urls`,
 * try multiple path resolution strategies to find the file on disk.
 *
 * Strategies tried in order:
 *  0. Anchored at the Django project root (manage.py dir) — the authoritative
 *     resolution for absolute module paths, when the project root is known
 *  1. Direct dot-to-slash: `module/path.py` and `module/path/__init__.py`
 *  2. Relative to the current file's directory
 *  3. Walk up the directory tree from the current file, trying each ancestor
 */
function resolveIncludedFile(
  modulePath: string,
  currentFilePath: string,
  readFile: DjangoFileReader,
  projectRoot: string | null,
): { filePath: string; content: string } | null {
  const basePath = modulePathToFilePath(modulePath);

  const candidates: string[] = [];

  // Strategy 0: anchored at the project root (sys.path entry). Tried first so
  // `include('app.urls')` from backend/ resolves to backend/app/urls.py rather
  // than a same-named app at the repo root.
  if (projectRoot !== null) {
    const anchored = projectRoot ? `${projectRoot}/${basePath}` : basePath;
    candidates.push(anchored + '.py');
    candidates.push(anchored + '/__init__.py');
  }

  // Strategy 1: direct path (app/urls.py, app/urls/__init__.py)
  candidates.push(basePath + '.py');
  candidates.push(basePath + '/__init__.py');

  // Strategy 2: relative to current file's directory
  if (currentFilePath.includes('/')) {
    const dir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/') + 1);
    candidates.push(dir + basePath + '.py');
    candidates.push(dir + basePath + '/__init__.py');
  }

  // Strategy 3: walk up from current file, trying each ancestor
  let parentDir = currentFilePath.includes('/')
    ? currentFilePath.substring(0, currentFilePath.lastIndexOf('/'))
    : '';
  while (parentDir.length > 0) {
    const prefix = parentDir + '/';
    candidates.push(prefix + basePath + '.py');
    candidates.push(prefix + basePath + '/__init__.py');
    const nextSep = parentDir.lastIndexOf('/');
    if (nextSep < 0) break;
    parentDir = parentDir.substring(0, nextSep);
  }

  // Strategy 4: bare path with just the last segment (e.g. 'urls.py' from 'app.urls')
  const segments = basePath.split('/');
  if (segments.length > 1) {
    const lastSegment = segments[segments.length - 1];
    candidates.push(lastSegment + '.py');
    candidates.push(lastSegment + '/__init__.py');
  }

  for (const candidate of candidates) {
    const content = readFile(candidate);
    if (content !== null) return { filePath: candidate, content };
  }

  return null;
}

export function extractDjangoRoutes(
  tree: Parser.Tree,
  filePath: string,
  parser: Parser,
  readFile?: DjangoFileReader | null,
  _visited?: Set<string>,
): ExtractedRoute[] {
  const routeSet = _visited ?? new Set<string>();
  const entryKey = includeVisitKey(filePath, null);
  if (routeSet.has(entryKey)) return [];
  routeSet.add(entryKey);

  // Resolve the project root once (constant across the whole walk) so absolute
  // include() module paths anchor correctly even in a monorepo.
  const projectRoot = findDjangoProjectRoot(filePath, readFile);

  const listNodes = findUrlpatternsLists(tree.rootNode);
  if (listNodes.length === 0) return [];

  const routes: ExtractedRoute[] = [];
  const walkStack: WalkFrame[] = [];

  for (const listNode of listNodes) {
    walkStack.push({
      node: listNode,
      routeCtx: { prefix: null },
      currentFilePath: filePath,
      depth: 0,
    });
  }

  while (walkStack.length > 0) {
    const { node, routeCtx, currentFilePath, depth } = walkStack.pop()!;

    if (node.type === 'list') {
      const children = node.children ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (child.type === '[' || child.type === ']' || child.type === ',') continue;
        walkStack.push({ node: child, routeCtx, currentFilePath, depth });
      }
      continue;
    }

    if (node.type === 'call') {
      const funcName = getCallFuncName(node);

      if (!funcName) {
        for (const child of node.children ?? []) {
          if (child.type === 'call' || child.type === 'list') {
            walkStack.push({ node: child, routeCtx, currentFilePath, depth });
          }
        }
        continue;
      }

      if (DJANGO_ROUTE_FUNCTIONS.has(funcName)) {
        const argsNode = node.childForFieldName?.('arguments') ?? null;

        let hasIncludeChild = false;
        if (argsNode) {
          for (const child of argsNode.children ?? []) {
            if (child.type === 'call' && getCallFuncName(child) === DJANGO_INCLUDE_FUNCTION) {
              hasIncludeChild = true;
              const modulePath = getIncludeModulePath(child);
              if (modulePath && readFile && depth < MAX_INCLUDE_DEPTH) {
                const resolved = resolveIncludedFile(
                  modulePath,
                  currentFilePath,
                  readFile,
                  projectRoot,
                );
                // Key the guard on (file, accumulated prefix) so the same
                // urlconf mounted under another prefix elsewhere is still walked.
                const childPrefix = makePrefix(routeCtx.prefix, extractStringArg(argsNode));
                if (resolved && !routeSet.has(includeVisitKey(resolved.filePath, childPrefix))) {
                  routeSet.add(includeVisitKey(resolved.filePath, childPrefix));
                  let childTree: Parser.Tree;
                  try {
                    childTree = parseSourceSafe(parser, resolved.content);
                  } catch {
                    continue;
                  }
                  const childLists = findUrlpatternsLists(childTree.rootNode);
                  for (const childList of childLists) {
                    walkStack.push({
                      node: childList,
                      routeCtx: { prefix: childPrefix },
                      currentFilePath: resolved.filePath,
                      depth: depth + 1,
                    });
                  }
                }
              }
            }
          }
        }

        if (!hasIncludeChild) {
          routes.push(emitDjangoRoute(node, currentFilePath, routeCtx));
        }
        continue;
      }

      if (funcName === DJANGO_INCLUDE_FUNCTION && readFile && depth < MAX_INCLUDE_DEPTH) {
        const modulePath = getIncludeModulePath(node);
        if (modulePath) {
          const resolved = resolveIncludedFile(modulePath, currentFilePath, readFile, projectRoot);
          // Bare include() inherits the current prefix; key the guard on it so a
          // shared urlconf reached under two prefixes is walked once per prefix.
          if (resolved && !routeSet.has(includeVisitKey(resolved.filePath, routeCtx.prefix))) {
            routeSet.add(includeVisitKey(resolved.filePath, routeCtx.prefix));
            let childTree: Parser.Tree;
            try {
              childTree = parseSourceSafe(parser, resolved.content);
            } catch {
              continue;
            }
            const childLists = findUrlpatternsLists(childTree.rootNode);
            for (const childList of childLists) {
              walkStack.push({
                node: childList,
                routeCtx,
                currentFilePath: resolved.filePath,
                depth: depth + 1,
              });
            }
          }
        }
        continue;
      }

      for (const child of node.children ?? []) {
        if (child.type === 'call' || child.type === 'list') {
          walkStack.push({ node: child, routeCtx, currentFilePath, depth });
        }
      }
      continue;
    }

    for (const child of node.children ?? []) {
      if (child.type === '(' || child.type === ')' || child.type === ',') continue;
      if (child.type === 'call' || child.type === 'list') {
        walkStack.push({ node: child, routeCtx, currentFilePath, depth });
      }
    }
  }

  return routes;
}
