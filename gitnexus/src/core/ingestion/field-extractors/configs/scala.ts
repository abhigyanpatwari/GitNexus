import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

export const scalaFieldConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Scala,
  typeDeclarationNodes: ['class_definition', 'object_definition', 'trait_definition'],
  fieldNodeTypes: ['val_definition', 'var_definition', 'val_declaration', 'var_declaration'],
  bodyNodeTypes: ['template_body'],
  defaultVisibility: 'public',

  extractName(node) {
    const pattern = node.childForFieldName('pattern');
    if (pattern?.type === 'identifier') return pattern.text;
    return undefined;
  },

  extractType(node) {
    const typeNode = node.childForFieldName('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    return undefined;
  },

  extractVisibility(node) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        if (child.text?.includes('private')) return 'private';
        if (child.text?.includes('protected')) return 'protected';
      }
    }
    return 'public';
  },

  isStatic(_node) {
    return false;
  },

  isReadonly(node) {
    return node.type === 'val_definition' || node.type === 'val_declaration';
  },
};
