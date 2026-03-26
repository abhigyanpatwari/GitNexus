// gitnexus/src/core/ingestion/field-extractors/configs/c-cpp.ts

import { SupportedLanguages } from '../../../../config/supported-languages.js';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { FieldVisibility } from '../../field-types.js';

/**
 * Detect C++ access specifier (public:/private:/protected:) by walking
 * backwards from the field node through siblings.
 */
function cppAccessSpecifier(node: SyntaxNode): FieldVisibility | undefined {
  let sibling = node.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'access_specifier') {
      const text = sibling.text.replace(':', '').trim();
      if (text === 'public' || text === 'private' || text === 'protected') return text;
    }
    sibling = sibling.previousNamedSibling;
  }
  return undefined;
}

function extractFieldName(node: SyntaxNode): string | undefined {
  // field_declaration > declarator:(field_identifier | pointer_declarator > field_identifier)
  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    if (declarator.type === 'field_identifier') return declarator.text;
    // pointer_declarator: *fieldName
    for (let i = 0; i < declarator.namedChildCount; i++) {
      const child = declarator.namedChild(i);
      if (child?.type === 'field_identifier') return child.text;
    }
    return declarator.text;
  }
  // fallback
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'field_identifier') return child.text;
  }
  return undefined;
}

function extractFieldType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  // fallback: first child that is a type node
  const first = node.firstNamedChild;
  if (first && (first.type === 'type_identifier' || first.type === 'primitive_type'
    || first.type === 'sized_type_specifier' || first.type === 'template_type')) {
    return extractSimpleTypeName(first) ?? first.text?.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// C++ config
// ---------------------------------------------------------------------------

export const cppConfig: FieldExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  typeDeclarationNodes: [
    'struct_specifier',
    'class_specifier',
    'union_specifier',
  ],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'private', // C++ class default is private

  extractName: extractFieldName,
  extractType: extractFieldType,

  extractVisibility(node) {
    const access = cppAccessSpecifier(node);
    if (access) return access;
    // struct default = public, class default = private
    const parent = node.parent?.parent;
    return parent?.type === 'struct_specifier' ? 'public' : 'private';
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'const');
  },
};

// ---------------------------------------------------------------------------
// C config (subset of C++)
// ---------------------------------------------------------------------------

export const cConfig: FieldExtractionConfig = {
  language: SupportedLanguages.C,
  typeDeclarationNodes: [
    'struct_specifier',
    'union_specifier',
  ],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'public', // C structs are always public

  extractName: extractFieldName,
  extractType: extractFieldType,

  extractVisibility(_node) {
    return 'public'; // C has no access control
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'const');
  },
};
