/**
 * TypeScript 7 AST + Checker surface for test-only walks that need types.
 *
 * TypeScript 7.0 dropped the classic Compiler API (`createProgram` /
 * `getTypeChecker`). The native `typescript/unstable/sync` client exposes the
 * same Checker methods against the Go compiler, and `typescript/unstable/ast`
 * is the matching syntax tree.
 */
export { SyntaxKind } from 'typescript/unstable/ast';
export type {
  CallExpression,
  Expression,
  Node,
  PropertyAccessExpression,
  SourceFile,
  StringLiteral,
} from 'typescript/unstable/ast';
export {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isCaseClause,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isIfStatement,
  isMethodDeclaration,
  isNewExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isStringLiteral,
  isStringLiteralLikeNode as isStringLiteralLike,
  isSwitchStatement,
  isVariableDeclaration,
} from 'typescript/unstable/ast/is';
export { API, type Checker, type Program } from 'typescript/unstable/sync';

import type { Node } from 'typescript/unstable/ast';

export function forEachChild(node: Node, visitor: (child: Node) => void): void {
  node.forEachChild(visitor);
}
