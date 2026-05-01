import { SupportedLanguages } from 'gitnexus-shared';
import type { MethodExtractionConfig, ParameterInfo } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractLuaName(node: SyntaxNode): string | undefined {
  const nameField = node.childForFieldName('name');
  if (!nameField) return undefined;
  if (nameField.type === 'identifier') return nameField.text;
  if (nameField.type === 'variable') {
    const method = nameField.childForFieldName('method');
    if (method) return method.text;
    const field = nameField.childForFieldName('field');
    if (field) return field.text;
  }
  return undefined;
}

function extractLuaParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const child = paramList.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier') {
      params.push({
        name: child.text,
        type: null,
        rawType: null,
        isOptional: false,
        isVariadic: false,
      });
    } else if (child.type === 'vararg_expression') {
      params.push({
        name: '...',
        type: null,
        rawType: null,
        isOptional: false,
        isVariadic: true,
      });
    }
  }
  return params;
}

function extractLuaOwnerName(node: SyntaxNode): string | undefined {
  const nameField = node.childForFieldName('name');
  if (nameField?.type !== 'variable') return undefined;
  const table = nameField.childForFieldName('table');
  return table?.type === 'identifier' ? table.text : undefined;
}

export const luaMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Lua,
  typeDeclarationNodes: ['function_definition_statement', 'local_function_definition_statement'],
  methodNodeTypes: ['function_definition_statement', 'local_function_definition_statement'],
  bodyNodeTypes: [],

  extractName: extractLuaName,

  extractReturnType(_node) {
    return undefined; // Lua is dynamically typed
  },

  extractParameters: extractLuaParameters,

  extractVisibility(_node) {
    return 'public';
  },

  extractReceiverType(node) {
    return extractLuaOwnerName(node);
  },

  extractOwnerName: extractLuaOwnerName,

  isStatic(node) {
    const nameField = node.childForFieldName('name');
    if (nameField?.type !== 'variable') return true;
    return nameField.childForFieldName('method') == null;
  },

  isAbstract(_node) {
    return false;
  },

  isFinal(_node) {
    return false;
  },
};
