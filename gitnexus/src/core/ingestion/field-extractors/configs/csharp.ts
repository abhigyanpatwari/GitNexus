// gitnexus/src/core/ingestion/field-extractors/configs/csharp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword, hasModifier, collectModifierTexts } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility, FieldInfo, FieldExtractorContext } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

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
    // Detect compound C# visibilities: protected internal, private protected
    const mods = collectModifierTexts(node);
    if (mods.has('protected') && mods.has('internal')) return 'protected internal';
    if (mods.has('private') && mods.has('protected')) return 'private protected';
    return findVisibility(node, CSHARP_VIS, 'private', 'modifier');
  },

  isStatic(node) {
    return hasKeyword(node, 'static') || hasModifier(node, 'modifier', 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'readonly') || hasModifier(node, 'modifier', 'readonly');
  },

  extractPrimaryFields(ownerNode: SyntaxNode, context: FieldExtractorContext): FieldInfo[] {
    // C# record positional parameters become public init-only properties.
    // C# 12 class primary constructor parameters are captured as private fields.
    // The parameter_list has no field name — find it by type.
    let paramList: SyntaxNode | null = null;
    for (let i = 0; i < ownerNode.namedChildCount; i++) {
      const child = ownerNode.namedChild(i);
      if (child?.type === 'parameter_list') {
        paramList = child;
        break;
      }
    }
    if (!paramList) return [];

    const isRecord = ownerNode.type === 'record_declaration';
    const fields: FieldInfo[] = [];

    for (let i = 0; i < paramList.namedChildCount; i++) {
      const param = paramList.namedChild(i);
      if (!param || param.type !== 'parameter') continue;

      const nameNode = param.childForFieldName('name');
      const typeNode = param.childForFieldName('type');
      if (!nameNode) continue;

      fields.push({
        name: nameNode.text,
        type: typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null) : null,
        // Record params are public init-only properties; class params are private captured fields
        visibility: isRecord ? 'public' : 'private',
        isStatic: false,
        isReadonly: isRecord, // record properties are init-only (readonly)
        sourceFile: context.filePath,
        line: param.startPosition.row + 1,
      });
    }

    return fields;
  },
};
