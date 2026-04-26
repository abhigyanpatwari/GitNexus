// gitnexus/src/core/ingestion/variable-extractors/configs/zig.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig, VariableVisibility } from '../../variable-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Zig variable extraction config.
 *
 * Zig has a single `variable_declaration` node type that covers both
 * `const` and `var`. The const/var distinction is an anonymous keyword
 * child of the declaration. There is no separate `static` concept at
 * the declaration level (statics are achieved via comptime initialization).
 *
 * Type-bearing declarations whose RHS is struct/enum/union are treated
 * as type declarations by the class extractor, so they should not also
 * surface as ordinary variables. The query in tree-sitter-queries.ts
 * already filters those out with a #not-match? predicate.
 */

function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.text === keyword) return true;
  }
  return false;
}

export const zigVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Zig,
  // Zig's variable_declaration covers both const and var; the factory uses
  // these sets primarily for routing — overlap is fine because isConst() is
  // the source of truth at extraction time.
  constNodeTypes: ['variable_declaration'],
  staticNodeTypes: [],
  variableNodeTypes: ['variable_declaration'],

  extractName(node: SyntaxNode): string | undefined {
    if (node.type !== 'variable_declaration') return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'identifier') return c.text;
    }
    return undefined;
  },

  extractType(node: SyntaxNode): string | undefined {
    const typeNode = node.childForFieldName?.('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    return undefined;
  },

  extractVisibility(node: SyntaxNode): VariableVisibility {
    return hasKeyword(node, 'pub') ? 'public' : 'private';
  },

  isConst(node: SyntaxNode): boolean {
    return hasKeyword(node, 'const');
  },

  isStatic(_node: SyntaxNode): boolean {
    return false;
  },

  isMutable(node: SyntaxNode): boolean {
    return hasKeyword(node, 'var');
  },
};
