import type Parser from 'tree-sitter';
import path from 'node:path';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { composeRouteGroupStack, type RouteGroupContext } from './php-route-group.js';
import {
  findRouteGroupClosureBody,
  getRouterCallArguments,
  getRouterCallMethodName,
  isPhpRouterGroupCall,
  parseRouteGroupArrayArgs,
  readPhpString,
} from './laravel.js';

export interface ExtractedPhpRouteRequireBinding {
  filePath: string;
  /** Repo-relative path to the required PHP file (normalized slashes). */
  requiredPath: string;
  prefix: string | null;
  namespace: string | null;
  middleware: string[];
  namePrefix: string | null;
  lineNumber: number;
  /** `require_once` / `include_once`: PHP skips the file if it already ran. */
  once: boolean;
  /** False for a top-level include: it marks the file as already run without adding a group. */
  appliesContext: boolean;
  /** False when the require sits under if/loop/try, so it may not have run. */
  unguarded: boolean;
}

export function shouldExtractPhpRouterRequireBindings(content: string): boolean {
  if (!/->\s*group\s*\(/.test(content)) return false;
  return /\b(require|require_once|include|include_once)\b/.test(content);
}

function resolveRequirePath(bootstrapRelPath: string, expr: SyntaxNode | null): string | null {
  if (!expr) return null;
  const bootstrapDir = path.posix.dirname(bootstrapRelPath.replace(/\\/g, '/'));

  const literalFromNode = (node: SyntaxNode): string | null => {
    if (node.type === 'string' || node.type === 'encapsed_string') {
      return readPhpString(node);
    }
    if (node.type === 'parenthesized_expression') {
      return literalFromNode(node.namedChildren?.[0] ?? node);
    }
    if (node.type === 'binary_expression') {
      const op = node.children?.find((c: SyntaxNode) => c.type === '.');
      if (!op) return null;
      const left = node.children?.[0];
      const right = node.children?.[2] ?? node.children?.[node.children.length - 1];
      const leftLit =
        left?.type === 'name' && left.text === '__DIR__'
          ? bootstrapDir
          : left
            ? literalFromNode(left)
            : null;
      const rightLit = right ? literalFromNode(right) : null;
      if (leftLit === null || rightLit === null) return null;
      return leftLit + rightLit;
    }
    return null;
  };

  const resolved = literalFromNode(expr);
  if (!resolved) return null;
  return path.posix.normalize(resolved.replace(/\\/g, '/')).replace(/^\.\//, '');
}

function isRequireCall(node: SyntaxNode): boolean {
  if (node.type === 'expression_statement') {
    const inner = node.children?.[0];
    return inner !== undefined && isRequireCall(inner);
  }
  if (
    node.type === 'include_expression' ||
    node.type === 'require_expression' ||
    node.type === 'include_once_expression' ||
    node.type === 'require_once_expression'
  ) {
    return true;
  }
  if (node.type === 'function_call_expression') {
    const name =
      getRouterCallMethodName(node) ?? node.children?.find((c) => c.type === 'name')?.text;
    return (
      name === 'require' || name === 'require_once' || name === 'include' || name === 'include_once'
    );
  }
  return false;
}

function requireArgument(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'expression_statement') {
    const inner = node.children?.[0];
    return inner ? requireArgument(inner) : null;
  }
  if (
    node.type === 'include_expression' ||
    node.type === 'require_expression' ||
    node.type === 'include_once_expression' ||
    node.type === 'require_once_expression'
  ) {
    return (
      node.children?.find(
        (c) =>
          c.type === 'parenthesized_expression' ||
          c.type === 'string' ||
          c.type === 'binary_expression' ||
          c.type === 'encapsed_string',
      ) ?? null
    );
  }
  if (node.type === 'function_call_expression') {
    return (
      getRouterCallArguments(node)?.children?.find((c) => c.type === 'argument')?.children?.[0] ??
      null
    );
  }
  return null;
}

function isOnceRequire(node: SyntaxNode): boolean {
  if (node.type === 'expression_statement') {
    const inner = node.children?.[0];
    return inner !== undefined && isOnceRequire(inner);
  }
  if (node.type === 'include_once_expression' || node.type === 'require_once_expression') {
    return true;
  }
  if (node.type === 'function_call_expression') {
    const name =
      getRouterCallMethodName(node) ?? node.children?.find((c) => c.type === 'name')?.text;
    return name === 'require_once' || name === 'include_once';
  }
  return false;
}

/** Statements whose body runs only conditionally, so a require inside them may not have run. */
const CONDITIONAL_NODE_TYPES = new Set([
  'if_statement',
  'foreach_statement',
  'for_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
  'conditional_expression',
]);

/** Bodies that do not run when the enclosing group closure runs. */
const DEFERRED_SCOPE_TYPES = new Set([
  'anonymous_function',
  'arrow_function',
  'function_definition',
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

/**
 * Visit a group closure body in source order, including requires nested under
 * `if`/loop/block statements. Nested group calls push their own context.
 */
function visitGroupBody(
  body: SyntaxNode,
  hostFilePath: string,
  stack: RouteGroupContext[],
  bindings: ExtractedPhpRouteRequireBinding[],
): void {
  const pending: { node: SyntaxNode; stack: RouteGroupContext[]; unguarded: boolean }[] = [];
  const pushChildren = (node: SyntaxNode, frameStack: RouteGroupContext[], unguarded: boolean) => {
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push({ node: children[i], stack: frameStack, unguarded });
    }
  };
  pushChildren(body, stack, true);

  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) continue;
    const { node, stack: frameStack, unguarded } = frame;
    if (isRequireCall(node)) {
      const requiredPath = resolveRequirePath(hostFilePath, requireArgument(node));
      if (!requiredPath?.endsWith('.php')) continue;
      const merged = composeRouteGroupStack(frameStack, 'lumen');
      bindings.push({
        filePath: hostFilePath,
        requiredPath,
        prefix: merged.prefix,
        namespace: merged.namespace,
        middleware: [...merged.middleware],
        namePrefix: merged.namePrefix,
        lineNumber: node.startPosition.row,
        once: isOnceRequire(node),
        appliesContext: true,
        unguarded,
      });
      continue;
    }
    if (isPhpRouterGroupCall(node)) {
      const argsNode = getRouterCallArguments(node);
      const groupCtx = parseRouteGroupArrayArgs(argsNode, 'lumen');
      const innerBody = findRouteGroupClosureBody(argsNode);
      if (innerBody) pushChildren(innerBody, [...frameStack, groupCtx], unguarded);
      continue;
    }
    if (DEFERRED_SCOPE_TYPES.has(node.type)) continue;
    pushChildren(node, frameStack, unguarded && !CONDITIONAL_NODE_TYPES.has(node.type));
  }
}

export function extractPhpRouterRequireBindings(
  tree: Parser.Tree,
  hostFilePath: string,
): ExtractedPhpRouteRequireBinding[] {
  const bindings: ExtractedPhpRouteRequireBinding[] = [];
  const relHost = hostFilePath.replace(/\\/g, '/');
  // `unguarded` is false under if/loop/try: a require there may not have run,
  // so it must not suppress a later require_once.
  const walkStack: { node: SyntaxNode; unguarded: boolean }[] = [
    { node: tree.rootNode, unguarded: true },
  ];

  while (walkStack.length > 0) {
    const frame = walkStack.pop();
    if (!frame) continue;
    const { node, unguarded } = frame;
    if (isPhpRouterGroupCall(node)) {
      const argsNode = getRouterCallArguments(node);
      const groupCtx = parseRouteGroupArrayArgs(argsNode, 'lumen');
      const body = findRouteGroupClosureBody(argsNode);
      if (body) visitGroupBody(body, relHost, [groupCtx], bindings);
      continue;
    }
    if (DEFERRED_SCOPE_TYPES.has(node.type)) {
      // A group inside a method still counts, but a require there has not run
      // at file-include time, so it cannot satisfy a later require_once.
      const children = node.children ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        walkStack.push({ node: children[i], unguarded: false });
      }
      continue;
    }
    if (unguarded && isRequireCall(node)) {
      const requiredPath = resolveRequirePath(relHost, requireArgument(node));
      if (requiredPath?.endsWith('.php')) {
        bindings.push({
          filePath: relHost,
          requiredPath,
          prefix: null,
          namespace: null,
          middleware: [],
          namePrefix: null,
          lineNumber: node.startPosition.row,
          once: isOnceRequire(node),
          appliesContext: false,
          unguarded: true,
        });
      }
      continue;
    }
    const childUnguarded = unguarded && !CONDITIONAL_NODE_TYPES.has(node.type);
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      walkStack.push({ node: children[i], unguarded: childUnguarded });
    }
  }

  return bindings;
}
