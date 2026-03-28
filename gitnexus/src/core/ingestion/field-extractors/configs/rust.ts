// gitnexus/src/core/ingestion/field-extractors/configs/rust.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import { hasKeyword } from './helpers.js';

/**
 * Rust field extraction config.
 *
 * Handles struct fields (named and tuple variants are out of scope).
 * Visibility: `pub` keyword = public, otherwise private (crate-private).
 * All fields are immutable by default in Rust (mutability is on the binding).
 */
export const rustConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Rust,
  typeDeclarationNodes: ['struct_item', 'enum_item'],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'private',

  extractName(node) {
    const name = node.childForFieldName('name');
    if (name) return name.text;
    // fallback: first field_identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'field_identifier') return child.text;
    }
    return undefined;
  },

  extractType(node) {
    const typeNode = node.childForFieldName('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    return undefined;
  },

  extractVisibility(node) {
    // Check for visibility_modifier named child (pub, pub(crate), pub(super))
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'visibility_modifier') return 'public';
    }
    return hasKeyword(node, 'pub') ? 'public' : 'private';
  },

  isStatic(_node) {
    return false; // Rust struct fields are never static
  },

  isReadonly(_node) {
    // All Rust fields are immutable by default (mutability is per-binding)
    return true;
  },
};
