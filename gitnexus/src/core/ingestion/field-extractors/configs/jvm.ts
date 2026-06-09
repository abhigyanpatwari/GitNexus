// gitnexus/src/core/ingestion/field-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword, hasModifier, typeFromField } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

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

/** A property_declaration is a companion-object member when its nearest
 *  class-body ancestor is the body of a companion_object (F52, issue #1919).
 *  Companion members are addressed statically through the enclosing class
 *  (`C.TAG`), so they are marked static. */
function isInsideKotlinCompanion(node: SyntaxNode): boolean {
  for (let cur = node.parent; cur !== null; cur = cur.parent) {
    if (cur.type === 'class_body') return cur.parent?.type === 'companion_object';
    if (cur.type === 'companion_object') return true;
  }
  return false;
}

export const kotlinConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Kotlin,
  // F52: include companion_object so a companion property's innermost
  // class-container owner (findEnclosingClassNode returns the companion_object)
  // is recognized as a type declaration and its nested class_body is walked.
  // The structure query already creates the Property node and owns it on the
  // ENCLOSING class for anonymous companions / on the named companion Class —
  // this entry only drives field-metadata enrichment, so it does NOT change
  // ownership or emit a second node (no double-count).
  typeDeclarationNodes: ['class_declaration', 'object_declaration', 'companion_object'],
  fieldNodeTypes: ['property_declaration'],
  bodyNodeTypes: ['class_body'],
  defaultVisibility: 'public',

  // F52: an anonymous `companion object { ... }` has no name child, so the
  // generic factory's `childForFieldName('name')` owner lookup is empty and
  // `extract()` would bail before walking the body. Supply a stable owner
  // name (the named companion's identifier, else "Companion") so the body IS
  // walked; the resulting FieldInfo map is keyed by field NAME only, so the
  // owner name does not affect which Property node gets enriched.
  extractOwnerName(node) {
    const typeIdentifierText = node.namedChildren.find((c) => c.type === 'type_identifier')?.text;
    if (node.type === 'companion_object') {
      // Anonymous companions have no type_identifier — fall back to "Companion".
      return typeIdentifierText ?? 'Companion';
    }
    const name = node.childForFieldName('name');
    if (name) return name.text;
    return typeIdentifierText;
  },

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
          if (
            t &&
            (t.type === 'user_type' ||
              t.type === 'type_identifier' ||
              t.type === 'nullable_type' ||
              t.type === 'generic_type')
          ) {
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

  isStatic(node) {
    // Kotlin has no `static`, but companion-object members are accessed
    // statically through the enclosing class (`C.TAG`) — mark them static
    // so the field metadata reflects that (F52).
    return isInsideKotlinCompanion(node);
  },

  isReadonly(node) {
    // 'val' = readonly, 'var' = mutable
    return hasKeyword(node, 'val');
  },
};
