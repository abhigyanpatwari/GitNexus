// gitnexus/src/core/ingestion/variable-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { hasKeyword, typeFromAnnotation } from '../../field-extractors/configs/helpers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * TypeScript/JavaScript variable extraction config.
 *
 * Handles module-scoped const/let/var declarations:
 * - `export const X = ...` → public, const
 * - `const X = ...` → private, const
 * - `let x = ...` → private, mutable
 * - `var x = ...` → private, mutable
 *
 * tree-sitter node structure:
 *   lexical_declaration (const/let) → variable_declarator → identifier (name)
 *   variable_declaration (var) → variable_declarator → identifier (name)
 */

function extractNameFromDecl(node: SyntaxNode): string | undefined {
  // lexical_declaration / variable_declaration → variable_declarator → name
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'variable_declarator') {
      const name = child.childForFieldName('name');
      if (name?.type === 'identifier') return name.text;
    }
  }
  return undefined;
}

function extractTypeFromDecl(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'variable_declarator') {
      return typeFromAnnotation(child);
    }
  }
  return undefined;
}

function extractVisFromDecl(node: SyntaxNode): VariableVisibility {
  // Check parent for export_statement wrapper
  const parent = node.parent;
  if (parent?.type === 'export_statement') return 'public';
  // Check for 'export' keyword as direct child
  if (hasKeyword(node, 'export')) return 'public';
  return 'private';
}

const shared: Omit<VariableExtractionConfig, 'language'> = {
  constNodeTypes: ['lexical_declaration'],
  staticNodeTypes: [],
  variableNodeTypes: ['variable_declaration'],

  extractName: extractNameFromDecl,
  extractType: extractTypeFromDecl,
  extractVisibility: extractVisFromDecl,

  isConst(node) {
    // lexical_declaration with 'const' keyword
    if (node.type === 'lexical_declaration') {
      return hasKeyword(node, 'const');
    }
    return false;
  },

  isStatic(_node) {
    // JS/TS module-level variables are not static in the class sense
    return false;
  },

  isMutable(node) {
    // var or let declarations are mutable; const is not
    if (node.type === 'variable_declaration') return true;
    if (node.type === 'lexical_declaration') {
      return hasKeyword(node, 'let');
    }
    return false;
  },
};

export const typescriptVariableConfig: VariableExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
};

export const javascriptVariableConfig: VariableExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
};
