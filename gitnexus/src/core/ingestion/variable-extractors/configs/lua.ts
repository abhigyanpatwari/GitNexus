import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig, VariableVisibility } from '../../variable-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractLuaVarName(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'variable_list') {
      const firstVar = child.namedChildren.find((c: SyntaxNode) => c.type === 'variable');
      if (firstVar) {
        const name = firstVar.childForFieldName('name');
        return name?.type === 'identifier' ? name.text : undefined;
      }
    }
  }
  return undefined;
}

export const luaVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Lua,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['local_variable_declaration', 'variable_assignment'],

  extractName: extractLuaVarName,

  extractType(_node) {
    return undefined; // Lua is dynamically typed
  },

  extractVisibility(node): VariableVisibility {
    return node.type === 'local_variable_declaration' ? 'private' : 'public';
  },

  isConst(_node) {
    return false;
  },

  isStatic(_node) {
    return false;
  },

  isMutable(_node) {
    return true;
  },
};
