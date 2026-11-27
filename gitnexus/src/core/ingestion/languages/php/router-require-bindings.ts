import type Parser from 'tree-sitter';
import path from 'node:path';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { ExtractedRouteRequireBinding } from '../../language-provider.js';
import {
  EMPTY_ROUTE_GROUP_CONTEXT,
  extendRouteGroupContext,
  isPhpRouteFile,
  type ComposedRouteGroupContext,
} from './route-group.js';
import {
  findRouteGroupClosureBody,
  foldPhpStringLiteral,
  getRouterCallArguments,
  getRouterCallMethodName,
  isPhpRouterGroupCall,
  parseRouteGroupArrayArgs,
} from '../../route-extractors/laravel.js';

export type ExtractedPhpRouteRequireBinding = ExtractedRouteRequireBinding;

export function shouldExtractPhpRouterRequireBindings(content: string): boolean {
  return /\b(require|include)(_once)?\b/i.test(content);
}

function isPhpIncludeKeyword(name: string | undefined): boolean {
  if (!name) return false;
  switch (name.toLowerCase()) {
    case 'require':
    case 'require_once':
    case 'include':
    case 'include_once':
      return true;
    default:
      return false;
  }
}

const INCLUDE_EXPRESSION_TYPES = new Set([
  'include_expression',
  'require_expression',
  'include_once_expression',
  'require_once_expression',
]);

/** The path argument when `node` is a require/include, else `undefined`. */
function requireArgument(node: SyntaxNode): SyntaxNode | null | undefined {
  if (INCLUDE_EXPRESSION_TYPES.has(node.type)) {
    return node.namedChildren?.find((c: SyntaxNode) => c.type !== 'comment') ?? null;
  }
  if (node.type === 'function_call_expression') {
    const name =
      getRouterCallMethodName(node) ?? node.children?.find((c) => c.type === 'name')?.text;
    if (!isPhpIncludeKeyword(name)) return undefined;
    return (
      getRouterCallArguments(node)?.children?.find((c) => c.type === 'argument')?.children?.[0] ??
      null
    );
  }
  return undefined;
}

function isOnceRequire(node: SyntaxNode): boolean {
  if (node.type === 'include_once_expression' || node.type === 'require_once_expression') {
    return true;
  }
  const name = getRouterCallMethodName(node)?.toLowerCase();
  return name === 'require_once' || name === 'include_once';
}

function resolveRequirePath(hostRelPath: string, expr: SyntaxNode | null): string | null {
  if (!expr) return null;
  const hostDir = path.posix.dirname(hostRelPath);
  const resolved = foldPhpStringLiteral(expr, (node) =>
    node.type === 'name' && node.text.toUpperCase() === '__DIR__' ? hostDir : undefined,
  );
  if (!resolved) return null;
  return path.posix.normalize(resolved.replace(/\\/g, '/')).replace(/^\.\//, '');
}

/** Bodies that do not run when the code around them runs. */
const DEFERRED_SCOPE_TYPES = new Set([
  'anonymous_function',
  'arrow_function',
  'function_definition',
  'method_declaration',
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

/** Exits that stop later sequential statements in the same block (`break` / `continue` do not). */
const EXIT_NODE_TYPES = new Set([
  'return_statement',
  'throw_expression',
  'exit_statement',
  'goto_statement',
]);

/**
 * Children of these run, in order, whenever the node runs. Anything else
 * (if, loops, `&&`, `?:`, try body, catch) may skip a child, so a require
 * below it is not proof that the file ran.
 */
const MUST_RUN_CONTAINER_TYPES = new Set([
  'program',
  'compound_statement',
  'expression_statement',
  'parenthesized_expression',
  'namespace_definition',
  'do_statement',
  'finally_clause',
]);

/** `throw` inside a try that has a catch clause is handled; execution may continue after the try. */
function throwIsCaughtByTry(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'catch_clause' || current.type === 'finally_clause') return false;
    if (current.type === 'try_statement') {
      return (current.children ?? []).some((child) => child.type === 'catch_clause');
    }
    current = current.parent;
  }
  return false;
}

/** Ids of nodes that contain an exit outside any nested deferred scope. */
function collectMayExit(root: SyntaxNode): Set<number> {
  const mayExit = new Set<number>();
  const stack: { node: SyntaxNode; done: boolean }[] = [{ node: root, done: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = frame.node.children ?? [];
    if (!frame.done) {
      stack.push({ node: frame.node, done: true });
      for (const child of children) stack.push({ node: child, done: false });
      continue;
    }
    if (EXIT_NODE_TYPES.has(frame.node.type)) {
      if (frame.node.type === 'throw_expression' && throwIsCaughtByTry(frame.node)) {
        continue;
      }
      mayExit.add(frame.node.id);
      continue;
    }
    for (const child of children) {
      if (!DEFERRED_SCOPE_TYPES.has(child.type) && mayExit.has(child.id)) {
        mayExit.add(frame.node.id);
        break;
      }
    }
  }
  return mayExit;
}

interface WalkFrame {
  node: SyntaxNode;
  /** Composed router-group context, or null outside any group. */
  group: ComposedRouteGroupContext | null;
  mustRun: boolean;
}

/**
 * Every require of a route file, with the router-group context it runs under.
 * The resolver decides which contexts survive; this only records facts.
 */
export function extractPhpRouterRequireBindings(
  tree: Parser.Tree,
  hostFilePath: string,
): ExtractedRouteRequireBinding[] {
  const bindings: ExtractedRouteRequireBinding[] = [];
  const relHost = hostFilePath.replace(/\\/g, '/');
  const mayExit = collectMayExit(tree.rootNode);

  const pushChildren = (frame: WalkFrame, children: readonly SyntaxNode[]) => {
    const { node, group, mustRun } = frame;
    const isTry = node.type === 'try_statement';
    let childMustRun = mustRun && (isTry || MUST_RUN_CONTAINER_TYPES.has(node.type));
    const ordered: WalkFrame[] = [];
    for (const child of children) {
      // Try/catch bodies may skip; `finally` always runs once the try statement is reached.
      const runs =
        isTry && child.type === 'finally_clause'
          ? mustRun
          : isTry && child.type === 'catch_clause'
            ? false
            : childMustRun;
      ordered.push({ node: child, group, mustRun: runs });
      if (!isTry || child.type !== 'finally_clause') {
        if (mayExit.has(child.id)) childMustRun = false;
      }
    }
    for (let i = ordered.length - 1; i >= 0; i--) walk.push(ordered[i]);
  };

  const walk: WalkFrame[] = [{ node: tree.rootNode, group: null, mustRun: true }];
  while (walk.length > 0) {
    const frame = walk.pop()!;
    const { node, group, mustRun } = frame;

    const arg = requireArgument(node);
    if (arg !== undefined) {
      const requiredPath = resolveRequirePath(relHost, arg);
      if (requiredPath && isPhpRouteFile(requiredPath)) {
        const ctx = group ?? EMPTY_ROUTE_GROUP_CONTEXT;
        bindings.push({
          filePath: relHost,
          requiredPath,
          prefix: ctx.prefix,
          namespace: ctx.namespace,
          namespaceResets: ctx.namespaceResets,
          middleware: [...ctx.middleware],
          namePrefix: ctx.namePrefix,
          lineNumber: node.startPosition.row,
          column: node.startPosition.column,
          once: isOnceRequire(node),
          appliesContext: group !== null,
          unguarded: mustRun,
        });
      }
      continue;
    }

    if (isPhpRouterGroupCall(node)) {
      const argsNode = getRouterCallArguments(node);
      const body = findRouteGroupClosureBody(argsNode);
      if (body) {
        const groupCtx = parseRouteGroupArrayArgs(argsNode, 'lumen');
        const inner = extendRouteGroupContext(
          group ?? EMPTY_ROUTE_GROUP_CONTEXT,
          groupCtx,
          'lumen',
        );
        // Lumen runs the group closure immediately, so it inherits mustRun.
        walk.push({ node: body, group: inner, mustRun });
      }
      continue;
    }

    if (DEFERRED_SCOPE_TYPES.has(node.type)) {
      // Runs later, if at all, and under whatever group is active then.
      pushChildren({ node, group: null, mustRun: false }, node.children ?? []);
      continue;
    }

    pushChildren(frame, node.children ?? []);
  }

  return bindings;
}
