import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig, VariableVisibility } from '../../variable-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractScalaVarName(node: SyntaxNode): string | undefined {
  const pattern = node.childForFieldName('pattern');
  if (pattern?.type === 'identifier') return pattern.text;
  return undefined;
}

function extractScalaVarType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  return undefined;
}

export const scalaVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Scala,
  constNodeTypes: ['val_definition'],
  staticNodeTypes: [],
  variableNodeTypes: ['var_definition'],

  extractName: extractScalaVarName,
  extractType: extractScalaVarType,

  extractVisibility(node): VariableVisibility {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        if (child.text?.includes('private')) return 'private';
        if (child.text?.includes('protected')) return 'protected';
      }
    }
    return 'public';
  },

  isConst(node) {
    return node.type === 'val_definition';
  },

  isStatic(_node) {
    return false;
  },

  isMutable(node) {
    return node.type === 'var_definition';
  },
};
