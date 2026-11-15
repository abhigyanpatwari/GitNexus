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
      return literalFromNode(node.children?.[0] ?? node);
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
      return path.posix.normalize(path.posix.join(leftLit, rightLit));
    }
    return null;
  };

  const resolved = literalFromNode(expr);
  if (!resolved) return null;
  return resolved.replace(/\\/g, '/').replace(/^\.\//, '');
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

function groupCallFromNode(node: SyntaxNode): SyntaxNode | null {
  const expr = node.type === 'expression_statement' ? node.children?.[0] : node;
  if (expr && isPhpRouterGroupCall(expr)) return expr;
  return null;
}

function visitGroupBody(
  body: SyntaxNode,
  hostFilePath: string,
  stack: RouteGroupContext[],
  bindings: ExtractedPhpRouteRequireBinding[],
): void {
  for (const child of body.children ?? []) {
    if (isRequireCall(child)) {
      const arg = requireArgument(child);
      const requiredPath = resolveRequirePath(hostFilePath, arg);
      if (!requiredPath?.endsWith('.php')) continue;
      const merged = composeRouteGroupStack(stack, 'lumen');
      bindings.push({
        filePath: hostFilePath,
        requiredPath,
        prefix: merged.prefix,
        namespace: merged.namespace,
        middleware: [...merged.middleware],
        namePrefix: merged.namePrefix,
        lineNumber: child.startPosition.row,
      });
      continue;
    }
    const nestedGroup = groupCallFromNode(child);
    if (nestedGroup) {
      const argsNode = getRouterCallArguments(nestedGroup);
      const groupCtx = parseRouteGroupArrayArgs(argsNode, 'lumen');
      const innerBody = findRouteGroupClosureBody(argsNode);
      if (innerBody) visitGroupBody(innerBody, hostFilePath, [...stack, groupCtx], bindings);
    }
  }
}

export function extractPhpRouterRequireBindings(
  tree: Parser.Tree,
  hostFilePath: string,
): ExtractedPhpRouteRequireBinding[] {
  const bindings: ExtractedPhpRouteRequireBinding[] = [];
  const relHost = hostFilePath.replace(/\\/g, '/');
  const walkStack: SyntaxNode[] = [tree.rootNode];

  while (walkStack.length > 0) {
    const node = walkStack.pop();
    if (!node) continue;
    if (isPhpRouterGroupCall(node)) {
      const argsNode = getRouterCallArguments(node);
      const groupCtx = parseRouteGroupArrayArgs(argsNode, 'lumen');
      const body = findRouteGroupClosureBody(argsNode);
      if (body) visitGroupBody(body, relHost, [groupCtx], bindings);
      continue;
    }
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) walkStack.push(children[i]);
  }

  return bindings;
}
