import path from 'node:path';

import type { SyntaxNode } from './utils/ast-helpers.js';

// Member-expression callees that should never classify a callback-wrapped
// binding as a top-level Function. This covers callback-taking Array methods
// plus a few value-returning methods that share the same AST shape.
export const ARRAY_METHOD_HOC_BLOCKLIST = [
  'map',
  'filter',
  'reduce',
  'forEach',
  'find',
  'findIndex',
  'some',
  'every',
  'flatMap',
  'sort',
  'splice',
  'slice',
  'concat',
  'fill',
  'copyWithin',
  'join',
  'flat',
  'at',
  'entries',
  'keys',
  'values',
  'indexOf',
  'lastIndexOf',
  'includes',
  'pop',
  'push',
  'shift',
  'unshift',
  'reverse',
  'reduceRight',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
] as const;

export const ARRAY_METHOD_HOC_BLOCKLIST_SET: ReadonlySet<string> = new Set(
  ARRAY_METHOD_HOC_BLOCKLIST,
);

// Identifier-callee default exports stay intentionally conservative: only a
// few obvious callback-taking built-ins are suppressed here. Framework HOCs
// like defineEventHandler still pass through and are named from the module.
export const DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST = [
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
] as const;

export const DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET: ReadonlySet<string> = new Set(
  DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST,
);

export const ARRAY_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'flatMap',
  'sort',
]);

export function buildNotAnyOfPredicate(captureName: string, values: readonly string[]): string {
  return `(#not-any-of? @${captureName} ${values.map((value) => `"${value}"`).join(' ')})`;
}

export const ARRAY_METHOD_NOT_ANY_OF_PREDICATE = buildNotAnyOfPredicate(
  'callee',
  ARRAY_METHOD_HOC_BLOCKLIST,
);

export const DEFAULT_EXPORT_IDENTIFIER_NOT_ANY_OF_PREDICATE = buildNotAnyOfPredicate(
  'hoc',
  DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST,
);

export function deriveDefaultExportHocName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  // Use individual path.posix helpers instead of path.posix.parse() to avoid
  // triggering the require-safe-parse ESLint rule (which treats any .parse()
  // call in src/core/ as a potential unsafe tree-sitter direct-parse).
  const ext = path.posix.extname(normalized);
  const name = path.posix.basename(normalized, ext);
  const dir = path.posix.dirname(normalized);

  if (name === 'index') {
    const parent = path.posix.basename(dir);
    if (parent !== '' && parent !== '.' && parent !== '/') return parent;
  }

  return name || 'default';
}

export function isDefaultExportHocFunctionNode(node: SyntaxNode): boolean {
  const args = node.parent;
  if (args === null || args.type !== 'arguments') return false;

  const callExpr = args.parent;
  if (callExpr === null || callExpr.type !== 'call_expression') return false;

  return callExpr.parent?.type === 'export_statement';
}

export function isBlockedDefaultExportHoc(node: SyntaxNode): boolean {
  if (!isDefaultExportHocFunctionNode(node)) return false;

  const callExpr = node.parent?.parent;
  if (callExpr === null || callExpr?.type !== 'call_expression') return false;

  const callee = callExpr.childForFieldName?.('function');
  return callee?.type === 'identifier' && DEFAULT_EXPORT_IDENTIFIER_BLOCKLIST_SET.has(callee.text);
}
