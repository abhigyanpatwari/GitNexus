// gitnexus/src/core/ingestion/field-extractors/configs/objc.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { FieldVisibility } from '../../field-types.js';

/**
 * Detect Objective-C access specifier (@public, @private, @protected)
 * by walking backwards from the field node through siblings.
 */
function objcAccessSpecifier(node: SyntaxNode): FieldVisibility | undefined {
  let sibling = node.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'visibility_modifier') {
      const text = sibling.text.replace('@', '').trim();
      if (text === 'public' || text === 'private' || text === 'protected') return text;
    }
    sibling = sibling.previousNamedSibling;
  }
  return undefined;
}

function extractFieldName(node: SyntaxNode): string | undefined {
  // property_declaration > declarator:(field_identifier | pointer_declarator > field_identifier)
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
  // fallback: look for field_identifier anywhere
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'field_identifier') return child.text;
    // nested declarator
    const nested = child?.firstNamedChild;
    if (nested?.type === 'field_identifier') return nested.text;
  }
  return undefined;
}

function extractFieldType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  // fallback: first child that is a type node
  const first = node.firstNamedChild;
  if (
    first &&
    (first.type === 'type_identifier' ||
      first.type === 'primitive_type' ||
      first.type === 'sized_type_specifier' ||
      first.type === 'macro_type_specifier')
  ) {
    return extractSimpleTypeName(first) ?? first.text?.trim();
  }
  return undefined;
}

// OC property attributes: @property (strong, nonatomic, readonly) etc.
function hasObjcReadonly(node: SyntaxNode): boolean {
  let sibling = node.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'property_attribute') {
      if (sibling.text.includes('readonly')) return true;
    }
    sibling = sibling.previousNamedSibling;
  }
  return false;
}

export const objcConfig: FieldExtractionConfig = {
  language: SupportedLanguages.ObjectiveC,
  typeDeclarationNodes: [
    'class_interface_declaration',
    'class_implementation_declaration',
    'protocol_declaration',
    'category_interface_declaration',
  ],
  fieldNodeTypes: ['property_declaration', 'instance_variable_declaration'],
  bodyNodeTypes: ['class_interface_body', 'class_implementation_body', 'protocol_body', 'category_interface_body'],
  defaultVisibility: 'private', // OC instance variables default to @private

  extractName: extractFieldName,
  extractType: extractFieldType,

  extractVisibility(node) {
    const access = objcAccessSpecifier(node);
    if (access) return access;
    // Instance variables default to @private inside @implementation
    return 'private';
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    if (node.type === 'property_declaration') return hasObjcReadonly(node);
    return hasKeyword(node, 'const');
  },
};
