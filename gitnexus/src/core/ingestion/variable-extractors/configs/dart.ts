// gitnexus/src/core/ingestion/variable-extractors/configs/dart.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Dart variable extraction config.
 *
 * Dart has top-level variable and constant declarations:
 * - `const maxSize = 100;`
 * - `final String name = "dart";`
 * - `var counter = 0;`
 * - `int x = 5;`
 *
 * tree-sitter-dart uses:
 * - top_level_variable_declaration for file-scope variables
 */

function extractDartVarName(node: SyntaxNode): string | undefined {
  // top_level_variable_declaration → initialized_variable_definition → identifier
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'initialized_variable_definition') {
      const name = child.childForFieldName('name');
      if (name) return name.text;
      // Fallback: first identifier
      for (let j = 0; j < child.namedChildCount; j++) {
        const gc = child.namedChild(j);
        if (gc?.type === 'identifier') return gc.text;
      }
    }
  }
  return undefined;
}

function extractDartVarType(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'initialized_variable_definition') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    }
  }
  // Look for type_identifier directly on the node
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'type_identifier') return child.text;
  }
  return undefined;
}

function hasDartKeyword(node: SyntaxNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.text === keyword) return true;
  }
  return false;
}

export const dartVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Dart,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['top_level_variable_declaration'],

  extractName: extractDartVarName,
  extractType: extractDartVarType,

  extractVisibility(node): VariableVisibility {
    const name = extractDartVarName(node);
    if (!name) return 'public';
    // Dart convention: underscore prefix = library-private
    return name.startsWith('_') ? 'private' : 'public';
  },

  isConst(node) {
    return hasDartKeyword(node, 'const') || hasDartKeyword(node, 'final');
  },

  isStatic(_node) {
    // Top-level Dart variables are not static
    return false;
  },

  isMutable(node) {
    return !hasDartKeyword(node, 'const') && !hasDartKeyword(node, 'final');
  },
};
