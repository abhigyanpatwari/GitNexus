/**
 * Parse-only TypeScript AST walks for tests.
 *
 * TypeScript 7.0 does not ship the classic Compiler API (`createSourceFile`).
 * These guards only need syntax, so they parse with `@babel/parser` (already a
 * CLI dependency) rather than spawning the native TypeScript 7 program API.
 */
import { parse } from '@babel/parser';
import { VISITOR_KEYS, type Comment, type File, type Node } from '@babel/types';

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

function isNode(value: unknown): value is AstNode {
  return !!value && typeof value === 'object' && typeof (value as Node).type === 'string';
}

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

export function lineAt(source: string, position: number): number {
  if (position <= 0) return 1;
  let line = 1;
  for (let i = 0; i < position && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
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
