/**
 * Parse-only TypeScript AST walks for tests.
 *
 * TypeScript 7.0 does not ship the classic Compiler API (`createSourceFile`).
 * These guards only need syntax, so they parse with `@babel/parser` (already a
 * CLI dependency) rather than spawning the native TypeScript 7 program API.
 */
import { parse } from '@babel/parser';
import {
  VISITOR_KEYS,
  isBinaryExpression,
  isNode,
  isStringLiteral,
  isTemplateLiteral,
  type Comment,
  type File,
  type MemberExpression,
  type Node,
  type OptionalMemberExpression,
  type TemplateLiteral,
} from '@babel/types';

export type AstNode = Node & { parent?: AstNode };

export interface ParsedSource {
  ast: File & { parent?: AstNode };
  source: string;
  fileName: string;
}

const PARSE_PLUGINS: NonNullable<Parameters<typeof parse>[1]>['plugins'] = [
  'typescript',
  'explicitResourceManagement',
  'importAttributes',
  'decoratorAutoAccessors',
  ['decorators', { decoratorsBeforeExport: true }],
];

export function forEachChild(node: Node, visit: (child: AstNode) => void): void {
  const keys = VISITOR_KEYS[node.type] ?? [];
  for (const key of keys) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) visit(item);
      }
    } else if (isNode(value)) {
      visit(value);
    }
  }
}

/** Direct descendants in source order (does not include `node` itself). */
export function collectDescendants(node: Node): AstNode[] {
  const out: AstNode[] = [];
  const visit = (child: AstNode): void => {
    out.push(child);
    forEachChild(child, visit);
  };
  forEachChild(node, visit);
  return out;
}

export function staticMemberName(
  node: MemberExpression | OptionalMemberExpression,
): string | undefined {
  return node.computed || node.property.type !== 'Identifier' ? undefined : node.property.name;
}

function templateLiteralText(node: TemplateLiteral): string | undefined {
  if (node.expressions.length > 0) return undefined;
  return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
}

/** Compile-time string from a literal, template without holes, or `+` chain. */
export function staticStringValue(node: Node | undefined | null): string | undefined {
  if (!node) return undefined;
  if (isStringLiteral(node)) return node.value;
  if (isTemplateLiteral(node)) return templateLiteralText(node);
  if (isBinaryExpression(node) && node.operator === '+') {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    if (left !== undefined && right !== undefined) return `${left}${right}`;
  }
  return undefined;
}

function attachParents(node: AstNode, parent?: AstNode): void {
  node.parent = parent;
  forEachChild(node, (child) => attachParents(child, node));
}

export function parseTypeScript(fileName: string, source: string): ParsedSource {
  const ast = parse(source, {
    sourceFilename: fileName,
    sourceType: 'unambiguous',
    plugins: PARSE_PLUGINS,
    errorRecovery: true,
    attachComment: true,
    ranges: true,
  }) as File & { parent?: AstNode };
  attachParents(ast);
  return { ast, source, fileName };
}

export function nodeStart(node: Node): number {
  return node.start ?? 0;
}

export function nodeEnd(node: Node): number {
  return node.end ?? 0;
}

export function nodeText(source: string, node: Node): string {
  return source.slice(nodeStart(node), nodeEnd(node));
}

let lineAtSource = '';
let lineAtStarts: number[] = [0];

function lineStarts(source: string): number[] {
  if (source === lineAtSource) return lineAtStarts;
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  lineAtSource = source;
  lineAtStarts = starts;
  return starts;
}

export function lineAt(source: string, position: number): number {
  if (position <= 0) return 1;
  const starts = lineStarts(source);
  const pos = Math.min(position, source.length);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface CommentRange {
  pos: number;
  end: number;
}

function toRange(comment: Comment): CommentRange | undefined {
  if (comment.start == null || comment.end == null) return undefined;
  return { pos: comment.start, end: comment.end };
}

export function leadingCommentRanges(node: Node): CommentRange[] {
  return (node.leadingComments ?? []).map(toRange).filter((range) => range !== undefined);
}

export function trailingCommentRanges(node: Node): CommentRange[] {
  return (node.trailingComments ?? []).map(toRange).filter((range) => range !== undefined);
}
