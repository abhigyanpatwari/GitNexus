// gitnexus/src/core/ingestion/variable-extractors/configs/ruby.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';

/**
 * Ruby variable extraction config.
 *
 * Ruby module-level constants use UPPER_CASE identifiers or start with
 * an uppercase letter. Ruby uses:
 * - assignment for variable declarations at module scope
 * - Constants: `MAX_SIZE = 100` or `Config = ...`
 * - Global variables: `$global = ...`
 */
export const rubyVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Ruby,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['assignment'],

  extractName(node) {
    const left = node.childForFieldName('left');
    if (!left) return undefined;
    if (left.type === 'identifier' || left.type === 'constant') return left.text;
    if (left.type === 'global_variable') return left.text;
    return undefined;
  },

  extractType(_node) {
    // Ruby is dynamically typed — no type annotations at module level
    return undefined;
  },

  extractVisibility(_node): VariableVisibility {
    const left = _node.childForFieldName('left');
    if (!left) return 'public';
    // Constants (uppercase start) and global variables are effectively public
    if (left.type === 'constant' || left.type === 'global_variable') return 'public';
    return 'private';
  },

  isConst(node) {
    const left = node.childForFieldName('left');
    return left?.type === 'constant';
  },

  isStatic(_node) {
    return false;
  },

  isMutable(node) {
    const left = node.childForFieldName('left');
    // Constants are immutable by convention
    return left?.type !== 'constant';
  },
};
