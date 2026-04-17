// gitnexus/src/core/ingestion/variable-extractors/configs/php.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { hasKeyword } from '../../field-extractors/configs/helpers.js';

/**
 * PHP variable extraction config.
 *
 * PHP has const declarations at namespace/file scope and global variables:
 * - `const MAX_SIZE = 100;`
 * - `define('MAX_SIZE', 100);`
 * - `$variable = value;`
 *
 * tree-sitter-php uses:
 * - const_declaration at namespace/program scope
 * - expression_statement containing assignment_expression for variables
 */
export const phpVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.PHP,
  constNodeTypes: ['const_declaration'],
  staticNodeTypes: [],
  variableNodeTypes: ['expression_statement'],

  extractName(node) {
    if (node.type === 'const_declaration') {
      // const_declaration → const_element → name (identifier)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'const_element') {
          const name = child.childForFieldName('name');
          return name?.text;
        }
      }
      return undefined;
    }
    // expression_statement → assignment_expression → variable_name
    const inner = node.firstNamedChild;
    if (inner?.type === 'assignment_expression') {
      const left = inner.childForFieldName('left');
      if (left?.type === 'variable_name') return left.text;
    }
    return undefined;
  },

  extractType(_node) {
    // PHP is dynamically typed — no inline type annotations for variables
    return undefined;
  },

  extractVisibility(_node): VariableVisibility {
    return 'public';
  },

  isConst(node) {
    return node.type === 'const_declaration';
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isMutable(node) {
    return node.type !== 'const_declaration';
  },
};
