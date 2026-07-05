// gitnexus/src/core/ingestion/field-extractors/configs/dart.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import type { FieldVisibility } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

/**
 * Dart field extraction config.
 *
 * Dart class fields appear as `declaration` nodes inside `class_body`.
 * Two shapes carry the field name(s):
 *   - instance / plain fields → `initialized_identifier_list`
 *     (`int z = 0;`, `int a = 1, b = 2;`)
 *   - `static const` / `static final` / `const` fields → `static_final_declaration_list`
 *     (`static const a = 1;`, `static final String b = 'x', c = 'y';`)
 * Both shapes may declare SEVERAL fields in one declaration, so name extraction
 * is multi-name (`extractNames`). The structure query (`DART_QUERIES`) emits one
 * `@definition.property` per name for both shapes; this config enriches each.
 *
 * Visibility is convention-based: underscore prefix = private.
 */

/** All field names declared by a `declaration` node, across both Dart shapes. */
function extractDartFieldNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    // instance / plain fields: initialized_identifier_list > initialized_identifier > identifier
    if (child.type === 'initialized_identifier_list') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const init = child.namedChild(j);
        if (init?.type === 'initialized_identifier') {
          const ident = init.firstNamedChild;
          if (ident?.type === 'identifier') names.push(ident.text);
        }
      }
    }

    // static const / final fields: static_final_declaration_list > static_final_declaration > identifier
    if (child.type === 'static_final_declaration_list') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const decl = child.namedChild(j);
        if (decl?.type === 'static_final_declaration') {
          const ident = decl.firstNamedChild;
          if (ident?.type === 'identifier') names.push(ident.text);
        }
      }
    }
  }
  return names;
}

export const dartConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Dart,
  typeDeclarationNodes: ['class_definition'],
  fieldNodeTypes: ['declaration'],
  bodyNodeTypes: ['class_body'],
  defaultVisibility: 'public',

  // One AST `declaration` node may declare several fields (`int a, b;`,
  // `static final String b = 'x', c = 'y';`), so use the multi-name path.
  extractName(node) {
    return extractDartFieldNames(node)[0];
  },

  extractNames(node) {
    return extractDartFieldNames(node);
  },

  extractType(node) {
    // declaration > type_identifier (the type annotation, present for both the
    // instance-field shape and `static final String b = …`). `static const a = 1;`
    // has no annotation → undefined (untyped).
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'type_identifier' || child.type === 'function_type')) {
        return extractSimpleTypeName(child) ?? child.text?.trim();
      }
    }
    return undefined;
  },

  // Per-name: Dart convention is underscore-prefixed = private. A single
  // declaration can mix visibilities (`static const _p = 1, q = 2;`), so the
  // decision is keyed on the individual field name.
  extractVisibilityForName(_node, name): FieldVisibility {
    return name.startsWith('_') ? 'private' : 'public';
  },

  extractVisibility(node): FieldVisibility {
    const first = extractDartFieldNames(node)[0];
    return first?.startsWith('_') ? 'private' : 'public';
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    // `final` / `const` (both `final_builtin`/`const_builtin` nodes whose text
    // is `final`/`const`) are read-only.
    return hasKeyword(node, 'final') || hasKeyword(node, 'const');
  },
};
