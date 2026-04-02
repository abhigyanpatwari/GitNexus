import type { SyntaxNode } from './ast-helpers.js';

export function extractJavaStringLiteral(
  node: Pick<SyntaxNode, 'type' | 'text' | 'namedChildren'> | null | undefined,
): string | undefined {
  if (!node || node.type !== 'string_literal') return undefined;
  const fragment = node.namedChildren.find((child) => child.type === 'string_fragment');
  if (fragment) return fragment.text;
  return node.text.replace(/^"/, '').replace(/"$/, '');
}
