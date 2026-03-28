// gitnexus/src/core/ingestion/field-extractors/configs/dart.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

/**
 * Dart field extraction config.
 *
 * Dart class fields appear as declaration nodes inside class_body.
 * Visibility is convention-based: underscore prefix = private.
 */
export const dartConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Dart,
  typeDeclarationNodes: ['class_definition'],
  fieldNodeTypes: ['declaration'],
  bodyNodeTypes: ['class_body'],
  defaultVisibility: 'public',

  extractName(node) {
    // declaration > initialized_identifier_list > initialized_identifier > identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'initialized_identifier_list') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const init = child.namedChild(j);
          if (init?.type === 'initialized_identifier') {
            const ident = init.firstNamedChild;
            if (ident?.type === 'identifier') return ident.text;
          }
        }
      }
      if (child?.type === 'initialized_identifier') {
        const ident = child.firstNamedChild;
        if (ident?.type === 'identifier') return ident.text;
      }
    }
    // fallback: look for direct identifier
    const name = node.childForFieldName('name');
    return name?.text;
  },

  extractType(node) {
    // declaration > type_identifier (first named child usually)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (
        child &&
        (child.type === 'type_identifier' ||
          child.type === 'generic_type' ||
          child.type === 'function_type')
      ) {
        return extractSimpleTypeName(child) ?? child.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(node) {
    // Dart uses _ prefix for private
    // Walk to find the identifier name
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'initialized_identifier_list') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const init = child.namedChild(j);
          if (init?.type === 'initialized_identifier') {
            const ident = init.firstNamedChild;
            if (ident?.text?.startsWith('_')) return 'private';
          }
        }
      }
    }
    return 'public';
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'final') || hasKeyword(node, 'const');
  },
};
