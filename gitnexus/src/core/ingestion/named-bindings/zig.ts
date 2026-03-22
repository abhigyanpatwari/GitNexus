import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

const findAliasName = (node: SyntaxNode): string | undefined => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'identifier') return child.text;
  }
  return undefined;
};

export function extractZigNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  if (importNode.type !== 'variable_declaration') return undefined;

  const alias = findAliasName(importNode);
  if (!alias || alias === '_') return undefined;

  return [{ local: alias, exported: alias, isModuleAlias: true }];
}
