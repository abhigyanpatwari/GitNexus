// gitnexus/src/core/ingestion/variable-extractors/configs/go.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Go variable extraction config.
 *
 * Go has package-scoped var and const declarations:
 * - `var x int = 5`
 * - `const MaxSize = 100`
 * - `var ( ... )` grouped declarations
 *
 * tree-sitter-go uses:
 * - var_declaration → var_spec → identifier, type
 * - const_declaration → const_spec → identifier, type
 *
 * Visibility: uppercase first letter = exported (public), lowercase = unexported (package).
 */

function extractGoVarName(node: SyntaxNode): string | undefined {
  // var_declaration/const_declaration → var_spec/const_spec → identifier
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'var_spec' || child?.type === 'const_spec') {
      const name = child.childForFieldName('name');
      if (name) return name.text;
      // Fallback: first identifier child
      for (let j = 0; j < child.namedChildCount; j++) {
        const gc = child.namedChild(j);
        if (gc?.type === 'identifier') return gc.text;
      }
    }
  }
  // short_var_declaration: x := 5 → expression_list → identifier
  if (node.type === 'short_var_declaration') {
    const left = node.childForFieldName('left');
    if (left?.type === 'expression_list') {
      const firstIdent = left.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (firstIdent) return firstIdent.text;
    }
  }
  return undefined;
}

function extractGoVarType(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'var_spec' || child?.type === 'const_spec') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    }
  }
  return undefined;
}

export const goVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Go,
  constNodeTypes: ['const_declaration'],
  staticNodeTypes: [],
  variableNodeTypes: ['var_declaration', 'short_var_declaration'],

  extractName: extractGoVarName,
  extractType: extractGoVarType,

  extractVisibility(node): VariableVisibility {
    const name = extractGoVarName(node);
    if (!name) return 'package';
    // Go visibility: uppercase first letter = exported
    const firstChar = name.charAt(0);
    return firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()
      ? 'public'
      : 'package';
  },

  isConst(node) {
    return node.type === 'const_declaration';
  },

  isStatic(_node) {
    // Go does not have static declarations
    return false;
  },

  isMutable(node) {
    return node.type !== 'const_declaration';
  },
};
