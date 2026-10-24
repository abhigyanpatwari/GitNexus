// gitnexus/src/core/ingestion/field-extractors/configs/typescript-javascript.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { hasKeyword, findVisibility, typeFromAnnotation } from './helpers.js';
import type { FieldVisibility } from '../../field-types.js';

const VISIBILITY_KEYWORDS = new Set<FieldVisibility>(['public', 'private', 'protected']);

/**
 * The class a field's initializer constructs: `static DEFAULT = new Config()`
 * -> `Config`, `repo = new models.Repo()` -> `models.Repo`. `undefined` for any
 * other initializer — a literal, a call, a missing one.
 *
 * The same two constructor shapes (identifier, member expression) the JS and TS
 * scope queries bind a class field from (`@type-binding.constructor`). Those
 * bindings live in the CLASS scope, which has one map for static and instance
 * members, so a static field's binding is dropped there to keep it from
 * retyping an instance field of the same name (`isStaticClassFieldBinding`).
 * Recorded on the field instead, the static field keeps its type on its own
 * Property node, where nothing else can collide with it.
 */
export function constructedTypeOfFieldInitializer(node: SyntaxNode): string | undefined {
  const value = node.childForFieldName('value');
  if (value === null || value.type !== 'new_expression') return undefined;
  const constructorNode = value.childForFieldName('constructor');
  if (constructorNode === null) return undefined;
  if (constructorNode.type !== 'identifier' && constructorNode.type !== 'member_expression') {
    return undefined;
  }
  return constructorNode.text;
}

const shared: Omit<FieldExtractionConfig, 'language'> = {
  typeDeclarationNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
  ],
  fieldNodeTypes: ['public_field_definition', 'property_signature', 'field_definition'],
  bodyNodeTypes: ['class_body', 'interface_body', 'object_type'],
  defaultVisibility: 'public',

  extractName(node) {
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
    return nameNode?.text;
  },

  extractType(node) {
    // tree-sitter TS uses a named 'type' field for type_annotation
    const typeField = node.childForFieldName('type');
    if (typeField) {
      if (typeField.type === 'type_annotation') {
        const inner = typeField.firstNamedChild;
        return inner?.text?.trim();
      }
      return typeField.text?.trim();
    }
    return typeFromAnnotation(node);
  },

  extractInitializerType: constructedTypeOfFieldInitializer,

  extractVisibility(node) {
    // TypeScript accessibility_modifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'accessibility_modifier') {
        const t = child.text.trim() as FieldVisibility;
        if (VISIBILITY_KEYWORDS.has(t)) return t;
      }
    }
    return findVisibility(node, VISIBILITY_KEYWORDS, 'public', 'modifiers');
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isReadonly(node) {
    return hasKeyword(node, 'readonly');
  },
};

export const typescriptConfig: FieldExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
};

export const javascriptConfig: FieldExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
};
