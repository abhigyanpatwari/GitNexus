// gitnexus/src/core/ingestion/field-extractors/configs/swift.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword, hasModifier, findVisibility } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

const SWIFT_VIS = new Set<FieldVisibility>([
  'public',
  'private',
  'fileprivate',
  'internal',
  'open',
]);

/**
 * Swift field extraction config.
 *
 * Handles property_declaration inside class_body / protocol_body and
 * protocol_property_declaration inside protocol_body (F75 — protocol property
 * requirements like "var title: String { get }").
 *
 * tree-sitter-swift uses property_declaration for stored/computed properties.
 * A protocol property requirement parses to its own node type,
 * protocol_property_declaration, whose name lives in a "name:" pattern field
 * (pattern > value_binding_pattern + simple_identifier(bound_identifier)), its
 * type in a sibling type_annotation, and its "{ get }" / "{ get set }" in a
 * protocol_property_requirements child. Note: Swift reuses the "name:" field
 * across many positions (func name, every parameter label, parameter/return
 * type), so the name is synthesized from the simple_identifier inside the
 * pattern rather than read blindly off "name:".
 */
export const swiftConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Swift,
  typeDeclarationNodes: ['class_declaration', 'protocol_declaration'],
  fieldNodeTypes: ['property_declaration', 'protocol_property_declaration'],
  bodyNodeTypes: ['class_body', 'protocol_body'],
  defaultVisibility: 'internal',

  extractName(node) {
    // property_declaration > pattern > simple_identifier, and
    // protocol_property_declaration > name: (pattern ... simple_identifier).
    // For protocol_property_declaration the pattern wraps a leading
    // value_binding_pattern ("var") plus the simple_identifier — the loop
    // below skips the binding keyword and returns the identifier.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'pattern') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const ident = child.namedChild(j);
          if (ident?.type === 'simple_identifier') return ident.text;
        }
        return child.text;
      }
      if (child?.type === 'simple_identifier') return child.text;
    }
    // fallback: childForFieldName('name')
    const name = node.childForFieldName('name');
    return name?.text;
  },

  extractType(node) {
    // property_declaration > type_annotation > type_identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'type_annotation') {
        const inner = child.firstNamedChild;
        if (inner) return extractSimpleTypeName(inner) ?? inner.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(node) {
    return findVisibility(node, SWIFT_VIS, 'internal', 'modifiers');
  },

  isStatic(node) {
    // `static`/`class` (type-level) modifiers live inside a `modifiers`
    // wrapper for both property_declaration and protocol_property_declaration
    // (e.g. `static var shared: P { get }`), so check the wrapper too.
    // `hasKeyword` compares each direct child by `.text` equality: it matches a
    // single-modifier wrapper (`modifiers.text === 'static'`) but fails for a
    // multi-modifier wrapper (`private static` → `modifiers.text === 'private static'`),
    // which `hasModifier` handles by descending into the wrapper's children.
    return (
      hasKeyword(node, 'static') ||
      hasKeyword(node, 'class') ||
      hasModifier(node, 'modifiers', 'static') ||
      hasModifier(node, 'modifiers', 'class')
    );
  },

  isReadonly(node) {
    // 'let' = constant/readonly, 'var' = variable
    return hasKeyword(node, 'let');
  },
};
