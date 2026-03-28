// gitnexus/src/core/ingestion/field-extractors/configs/php.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

const PHP_VIS = new Set<FieldVisibility>(['public', 'private', 'protected']);

/**
 * PHP field extraction config.
 *
 * Handles property_declaration inside class/interface/trait bodies.
 * tree-sitter-php uses 'declaration_list' for the class body.
 */
export const phpConfig: FieldExtractionConfig = {
  language: SupportedLanguages.PHP,
  typeDeclarationNodes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
  fieldNodeTypes: ['property_declaration'],
  bodyNodeTypes: ['declaration_list'],
  defaultVisibility: 'public',

  extractName(node) {
    // property_declaration > property_element > variable_name ($varName)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'property_element') {
        const varName = child.childForFieldName('name') ?? child.firstNamedChild;
        if (varName) {
          // strip leading $ from PHP variable names
          const text = varName.text;
          return text.startsWith('$') ? text.slice(1) : text;
        }
      }
      // fallback: variable_name direct child
      if (child?.type === 'variable_name') {
        const text = child.text;
        return text.startsWith('$') ? text.slice(1) : text;
      }
    }
    return undefined;
  },

  extractType(node) {
    // property_declaration may have a type before the property_element
    // tree-sitter-php: type can be union_type, named_type, optional_type, primitive_type
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (
        child.type === 'union_type' ||
        child.type === 'named_type' ||
        child.type === 'optional_type' ||
        child.type === 'primitive_type' ||
        child.type === 'intersection_type' ||
        child.type === 'nullable_type'
      ) {
        return extractSimpleTypeName(child) ?? child.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(node) {
    return findVisibility(node, PHP_VIS, 'public');
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'readonly');
  },
};
