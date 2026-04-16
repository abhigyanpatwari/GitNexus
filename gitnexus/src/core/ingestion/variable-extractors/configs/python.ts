// gitnexus/src/core/ingestion/variable-extractors/configs/python.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Python variable extraction config.
 *
 * Handles module-level assignments and annotated assignments:
 * - `MAX_SIZE = 100` → const by UPPER_CASE convention
 * - `name: str = "default"` → annotated assignment with type
 * - `_private_var = 42` → protected by convention
 * - `__private_var = 42` → private by convention
 *
 * tree-sitter-python uses:
 * - expression_statement containing assignment or type nodes
 */

function extractNameFromPython(node: SyntaxNode): string | undefined {
  const inner = node.firstNamedChild;
  if (!inner) return undefined;

  // Annotated assignment: name: str = "default"
  // AST: expression_statement > type > identifier
  if (inner.type === 'type') {
    const ident = inner.childForFieldName('name') ?? inner.firstNamedChild;
    return ident?.type === 'identifier' ? ident.text : undefined;
  }

  // Plain assignment: x = 5
  if (inner.type === 'assignment') {
    const left = inner.childForFieldName('left');
    if (left?.type === 'identifier') return left.text;
  }

  return undefined;
}

function extractTypeFromPython(node: SyntaxNode): string | undefined {
  const inner = node.firstNamedChild;
  if (!inner) return undefined;

  if (inner.type === 'type') {
    const typeNode = inner.childForFieldName('type') ?? inner.namedChild(1);
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  }

  return undefined;
}

function extractVisFromPython(node: SyntaxNode): VariableVisibility {
  const name = extractNameFromPython(node);
  if (!name) return 'public';
  if (name.startsWith('__') && !name.endsWith('__')) return 'private';
  if (name.startsWith('_')) return 'protected';
  return 'public';
}

export const pythonVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Python,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['expression_statement'],

  extractName: extractNameFromPython,
  extractType: extractTypeFromPython,
  extractVisibility: extractVisFromPython,

  isConst(node) {
    // Python convention: UPPER_CASE names are constants
    const name = extractNameFromPython(node);
    if (!name) return false;
    return name === name.toUpperCase() && /^[A-Z][A-Z0-9_]*$/.test(name);
  },

  isStatic(_node) {
    return false;
  },

  isMutable(node) {
    const name = extractNameFromPython(node);
    if (!name) return true;
    // By convention, UPPER_CASE names are immutable constants
    return !(name === name.toUpperCase() && /^[A-Z][A-Z0-9_]*$/.test(name));
  },
};
