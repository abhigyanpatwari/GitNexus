import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Append .* to a Kotlin import path if the AST has a wildcard_import sibling node.
 * Pure function — returns a new string without mutating the input.
 */
export const appendKotlinWildcard = (importPath: string, importNode: SyntaxNode): string => {
  for (let i = 0; i < importNode.childCount; i++) {
    if (importNode.child(i)?.type === 'wildcard_import') {
      return importPath.endsWith('.*') ? importPath : `${importPath}.*`;
    }
  }
  return importPath;
};
