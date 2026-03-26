// gitnexus/src/core/ingestion/field-extractors/configs/csharp.ts

import { SupportedLanguages } from '../../../../config/supported-languages.js';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword, hasModifier } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

const CSHARP_VIS = new Set<FieldVisibility>(['public', 'private', 'protected', 'internal']);

/**
 * C# field extraction config.
 *
 * Handles field_declaration and property_declaration inside class/struct/interface bodies.
 * The body node in tree-sitter-c-sharp is 'declaration_list'.
 */
export const csharpConfig: FieldExtractionConfig = {
  language: SupportedLanguages.CSharp,
  typeDeclarationNodes: [
    'class_declaration',
    'struct_declaration',
    'interface_declaration',
    'record_declaration',
  ],
  fieldNodeTypes: ['field_declaration', 'property_declaration'],
  bodyNodeTypes: ['declaration_list'],
  defaultVisibility: 'private',

  extractName(node) {
    // field_declaration > variable_declaration > variable_declarator > identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declaration') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const declarator = child.namedChild(j);
          if (declarator?.type === 'variable_declarator') {
            const name = declarator.childForFieldName('name');
            return name?.text ?? declarator.firstNamedChild?.text;
          }
        }
      }
    }
    // property_declaration: name field
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;
    return undefined;
  },

  extractType(node) {
    // field_declaration > variable_declaration > type:(predefined_type | identifier | ...)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declaration') {
        const typeNode = child.childForFieldName('type');
        if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
        // fallback: first child that is a type
        const first = child.firstNamedChild;
        if (first && first.type !== 'variable_declarator') {
          return extractSimpleTypeName(first) ?? first.text?.trim();
        }
      }
    }
    // property_declaration: type is first named child
    const typeNode = node.childForFieldName('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    return undefined;
  },

  extractVisibility(node) {
    return findVisibility(node, CSHARP_VIS, 'private', 'modifier');
  },

  isStatic(node) {
    return hasKeyword(node, 'static') || hasModifier(node, 'modifier', 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'readonly') || hasModifier(node, 'modifier', 'readonly');
  },
};
