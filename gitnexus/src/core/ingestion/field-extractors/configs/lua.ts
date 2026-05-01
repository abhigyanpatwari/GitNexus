import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';

/**
 * Lua field extraction config.
 *
 * Lua tables are the only compound data type. Table fields are defined in
 * constructors ({ key = value }) or via assignment (tbl.key = value).
 * Tree-sitter-lua represents constructor fields as `field` nodes inside `table`.
 *
 * Lua has no visibility modifiers — all fields are public.
 */
export const luaFieldConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Lua,
  typeDeclarationNodes: ['local_variable_declaration', 'variable_assignment'],
  fieldNodeTypes: ['field'],
  bodyNodeTypes: ['field_list'],
  defaultVisibility: 'public',

  extractName(node) {
    const key = node.childForFieldName('key');
    return key?.type === 'identifier' ? key.text : undefined;
  },

  extractType(_node) {
    return undefined; // Lua is dynamically typed
  },

  extractVisibility(_node) {
    return 'public';
  },

  isStatic(_node) {
    return false;
  },

  isReadonly(_node) {
    return false;
  },
};
