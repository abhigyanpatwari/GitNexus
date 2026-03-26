// gitnexus/src/core/ingestion/field-extractors/configs/jvm.ts

import { SupportedLanguages } from '../../../../config/supported-languages.js';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword, hasModifier, typeFromField } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_VIS = new Set<FieldVisibility>(['public', 'private', 'protected']);

export const javaConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Java,
  typeDeclarationNodes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['class_body', 'interface_body', 'enum_body'],
  defaultVisibility: 'package',

  extractName(node) {
    // field_declaration > declarator:(variable_declarator name:(identifier))
    const declarator = node.childForFieldName('declarator');
    if (declarator) {
      const name = declarator.childForFieldName('name');
      return name?.text;
    }
    // fallback: walk children for variable_declarator
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declarator') {
        const name = child.childForFieldName('name');
        return name?.text;
      }
    }
    return undefined;
  },

  extractType(node) {
    // field_declaration > type:(type_identifier|generic_type|...)
    const t = typeFromField(node, 'type');
    if (t) return t;
    // fallback: first named child that looks like a type
    const first = node.firstNamedChild;
    if (first && first.type !== 'modifiers') {
      return extractSimpleTypeName(first) ?? first.text?.trim();
    }
    return undefined;
  },

  extractVisibility(node) {
    return findVisibility(node, JAVA_VIS, 'package', 'modifiers');
  },

  isStatic(node) {
    return hasKeyword(node, 'static') || hasModifier(node, 'modifiers', 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'final') || hasModifier(node, 'modifiers', 'final');
  },
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const KOTLIN_VIS = new Set<FieldVisibility>(['public', 'private', 'protected', 'internal']);

export const kotlinConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Kotlin,
  typeDeclarationNodes: [
    'class_declaration',
    'object_declaration',
  ],
  fieldNodeTypes: ['property_declaration'],
  bodyNodeTypes: ['class_body'],
  defaultVisibility: 'public',

  extractName(node) {
    // property_declaration > variable_declaration > simple_identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declaration') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const ident = child.namedChild(j);
          if (ident?.type === 'simple_identifier') return ident.text;
        }
      }
      if (child?.type === 'simple_identifier') return child.text;
    }
    return undefined;
  },

  extractType(node) {
    // property_declaration may have a user_type or type_identifier under variable_declaration
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declaration') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const t = child.namedChild(j);
          if (t && (t.type === 'user_type' || t.type === 'type_identifier'
            || t.type === 'nullable_type' || t.type === 'generic_type')) {
            return extractSimpleTypeName(t) ?? t.text?.trim();
          }
        }
      }
      if (child?.type === 'user_type' || child?.type === 'nullable_type') {
        return extractSimpleTypeName(child) ?? child.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(node) {
    return findVisibility(node, KOTLIN_VIS, 'public', 'modifiers');
  },

  isStatic(_node) {
    // Kotlin doesn't have static; companion object members are handled separately
    return false;
  },

  isReadonly(node) {
    // 'val' = readonly, 'var' = mutable
    return hasKeyword(node, 'val');
  },
};
