// gitnexus/src/core/ingestion/field-extractors/configs/solidity.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import type { FieldVisibility } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractVisibility(node: SyntaxNode): FieldVisibility {
  const read = (text: string): FieldVisibility | null => {
    if (text === 'public' || text === 'external') return 'public';
    if (text === 'internal') return 'internal';
    if (text === 'private') return 'private';
    return null;
  };

  const visField = node.childForFieldName('visibility');
  if (visField) {
    const mapped = read(visField.text.trim());
    if (mapped) return mapped;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'visibility') {
      const mapped = read(child.text.trim());
      if (mapped) return mapped;
    }
  }
  return 'internal'; // Solidity default for state variables
}

export const solidityFieldConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Solidity,
  typeDeclarationNodes: [
    'contract_declaration',
    'interface_declaration',
    'library_declaration',
    'struct_declaration',
  ],
  fieldNodeTypes: ['state_variable_declaration', 'struct_member'],
  bodyNodeTypes: ['contract_body', 'struct_declaration'],
  defaultVisibility: 'internal',

  extractName(node) {
    return node.childForFieldName('name')?.text;
  },

  extractType(node) {
    return node.childForFieldName('type')?.text?.trim();
  },

  extractVisibility,

  isStatic: () => false,
  isReadonly(node) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'constant' || child.type === 'immutable') return true;
      if (!child.isNamed && (child.text === 'constant' || child.text === 'immutable')) {
        return true;
      }
    }
    return false;
  },
};
