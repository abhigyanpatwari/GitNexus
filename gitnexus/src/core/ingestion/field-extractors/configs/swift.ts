// gitnexus/src/core/ingestion/field-extractors/configs/swift.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword, findVisibility } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

const SWIFT_VIS = new Set<FieldVisibility>([
  'public',
  'private',
  'fileprivate',
  'internal',
  'open',
]);

/**
 * Swift field extraction config.
 *
 * Handles property_declaration inside class_body / protocol_body.
 * tree-sitter-swift uses property_declaration for stored/computed properties.
 */
export const swiftConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Swift,
  typeDeclarationNodes: ['class_declaration', 'struct_declaration', 'protocol_declaration'],
  fieldNodeTypes: ['property_declaration'],
  bodyNodeTypes: ['class_body', 'protocol_body'],
  defaultVisibility: 'internal',

  extractName(node) {
    // property_declaration > pattern > simple_identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'pattern') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const ident = child.namedChild(j);
          if (ident?.type === 'simple_identifier') return ident.text;
        }
        return child.text;
      }
      if (child?.type === 'simple_identifier') return child.text;
    }
    // fallback: childForFieldName('name')
    const name = node.childForFieldName('name');
    return name?.text;
  },

  extractType(node) {
    // property_declaration > type_annotation > type_identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'type_annotation') {
        const inner = child.firstNamedChild;
        if (inner) return extractSimpleTypeName(inner) ?? inner.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(node) {
    return findVisibility(node, SWIFT_VIS, 'internal', 'modifiers');
  },

  isStatic(node) {
    return hasKeyword(node, 'static') || hasKeyword(node, 'class');
  },

  isReadonly(node) {
    // 'let' = constant/readonly, 'var' = variable
    return hasKeyword(node, 'let');
  },
};
