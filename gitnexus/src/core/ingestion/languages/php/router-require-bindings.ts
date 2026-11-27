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

/**
 * Hard exits skip the rest of the enclosing block and everything after it.
 * `break` / `continue` only skip later statements in the same loop or switch body.
 */
const HARD_EXIT_NODE_TYPES = new Set(['return_statement', 'throw_expression', 'exit_statement']);
const LOOP_LOCAL_EXIT_NODE_TYPES = new Set(['break_statement', 'continue_statement']);
const LOOP_OR_SWITCH_TYPES = new Set([
  'for_statement',
  'foreach_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
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

function catchTypeText(catchClause: SyntaxNode): string {
  const chunks: string[] = [];
  const walk = (node: SyntaxNode) => {
    if (node.type === 'name' || node.type === 'namespace_name') chunks.push(node.text);
    for (const child of node.children ?? []) walk(child);
  };
  for (const child of catchClause.children ?? []) {
    if (child.type === 'variable_name') break;
    walk(child);
  }
  return chunks.join('');
}

function namespaceHasName(node: SyntaxNode): boolean {
  return (node.children ?? []).some(
    (child) => child.type === 'namespace_name' || child.type === 'name',
  );
}

/**
 * `\Throwable` is always the global type. Unqualified `Throwable` is global
 * only when no named namespace is in effect at the catch.
 */
function inNamedNamespace(node: SyntaxNode): boolean {
  let root: SyntaxNode = node;
  while (root.parent) root = root.parent;
  let named = false;
  const visit = (current: SyntaxNode): boolean => {
    if (current === node) return true;
    if (current.type === 'namespace_definition') {
      const hasName = namespaceHasName(current);
      const braced = (current.children ?? []).some(
        (child) => child.type === 'compound_statement' || child.type === 'declaration_list',
      );
      if (braced) {
        const previous = named;
        named = hasName;
        for (const child of current.children ?? []) {
          if (visit(child)) return true;
        }
        named = previous;
        return false;
      }
      named = hasName;
    }
    for (const child of current.children ?? []) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return named;
}

function catchIsUniversalThrowable(catchClause: SyntaxNode): boolean {
  const raw = catchTypeText(catchClause);
  if (raw.replace(/^\\+/, '') !== 'Throwable') return false;
  if (raw.startsWith('\\')) return true;
  return !inNamedNamespace(catchClause);
}

function tryCatchesAllThrows(tryNode: SyntaxNode): boolean {
  return (tryNode.children ?? []).some(
    (child) => child.type === 'catch_clause' && catchIsUniversalThrowable(child),
  );
}

/** A throw is definitely caught only by an enclosing universal Throwable catch. */
function throwIsDefinitelyCaught(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'catch_clause' || current.type === 'finally_clause') {
      while (current && current.type !== 'try_statement') current = current.parent;
      current = current?.parent ?? null;
      continue;
    }
    if (current.type === 'try_statement' && tryCatchesAllThrows(current)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Nodes that can skip later siblings. Loop-local exits (`break` / `continue`)
 * do not propagate through the loop or switch statement itself.
 */
function collectMayExit(root: SyntaxNode): Set<number> {
  const mayExit = new Set<number>();
  const hard = new Set<number>();
  const stack: { node: SyntaxNode; done: boolean }[] = [{ node: root, done: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const children = frame.node.children ?? [];
    if (!frame.done) {
      stack.push({ node: frame.node, done: true });
      for (const child of children) stack.push({ node: child, done: false });
      continue;
    }
    if (LOOP_LOCAL_EXIT_NODE_TYPES.has(frame.node.type)) {
      if (loopExitLevels(frame.node) > 1) {
        mayExit.add(frame.node.id);
        hard.add(frame.node.id);
      } else {
        mayExit.add(frame.node.id);
      }
      continue;
    }
    if (HARD_EXIT_NODE_TYPES.has(frame.node.type)) {
      mayExit.add(frame.node.id);
      if (!(frame.node.type === 'throw_expression' && throwIsDefinitelyCaught(frame.node))) {
        hard.add(frame.node.id);
      }
      continue;
    }
    let childHard = false;
    let childLocal = false;
    for (const child of children) {
      if (DEFERRED_SCOPE_TYPES.has(child.type)) continue;
      if (hard.has(child.id)) childHard = true;
      else if (mayExit.has(child.id)) childLocal = true;
    }
    if (childHard) {
      mayExit.add(frame.node.id);
      hard.add(frame.node.id);
    } else if (
      childLocal &&
      !LOOP_OR_SWITCH_TYPES.has(frame.node.type) &&
      !(frame.node.type === 'try_statement' && tryCatchesAllThrows(frame.node))
    ) {
      mayExit.add(frame.node.id);
    }
  }
  return mayExit;
}

/** A statement that always leaves the block, so later siblings never run. */
const UNCONDITIONAL_EXIT_TYPES = new Set([
  'break_statement',
  'continue_statement',
  'return_statement',
  'throw_expression',
  'exit_statement',
]);

function loopExitLevels(node: SyntaxNode): number {
  const literal = (node.children ?? []).find((child) => child.type === 'integer');
  if (!literal) return 1;
  const levels = Number(literal.text);
  return Number.isFinite(levels) && levels > 0 ? levels : 1;
}

function statementExitsUnconditionally(node: SyntaxNode): boolean {
  if (node.type === 'goto_statement') return false;
  if (UNCONDITIONAL_EXIT_TYPES.has(node.type)) return true;
  if (node.type !== 'expression_statement') return false;
  const inner = (node.children ?? []).find((child) => child.type !== ';');
  return inner?.type === 'throw_expression';
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
      if (statementExitsUnconditionally(child)) break;
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
          controller: ctx.controller,
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
