// gitnexus/src/core/ingestion/field-extractors/configs/go.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Go field extraction config.
 *
 * Go struct fields live inside type_declaration > type_spec > struct_type >
 * field_declaration_list > field_declaration.
 *
 * Visibility in Go is based on the first character: uppercase = exported (public),
 * lowercase = unexported (package).
 */
function goVisibilityForName(name: string): FieldVisibility {
  const first = name.charAt(0);
  return first === first.toUpperCase() && first !== first.toLowerCase() ? 'public' : 'package';
}

function extractGoFieldNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'field_identifier') names.push(child.text);
  }
  return names;
}

export const goConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Go,
  typeDeclarationNodes: ['type_declaration', 'struct_type'],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'package',

  extractOwnerName(node) {
    if (node.type === 'struct_type') {
      return node.parent?.type === 'type_spec'
        ? node.parent.childForFieldName('name')?.text
        : undefined;
    }
    const typeSpec = node.namedChildren.find((child) => child.type === 'type_spec');
    return typeSpec?.childForFieldName('name')?.text;
  },

  findBodyNodes(node) {
    if (node.type === 'struct_type') {
      const body = node.namedChildren.find((child) => child.type === 'field_declaration_list');
      return body ? [body] : [];
    }
    const typeSpec = node.namedChildren.find((child) => child.type === 'type_spec');
    const typeNode = typeSpec?.childForFieldName('type');
    const body = typeNode?.namedChildren.find((child) => child.type === 'field_declaration_list');
    return body ? [body] : [];
  },

  extractName(node) {
    const firstName = extractGoFieldNames(node)[0];
    if (firstName) return firstName;

    // field_declaration > name:(field_identifier)
    const name = node.childForFieldName('name');
    if (name) return name.text;
    // fallback: first field_identifier child
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'field_identifier') return child.text;
    }
    return undefined;
  },

  extractNames: extractGoFieldNames,

  extractType(node) {
    // field_declaration > type:(type_identifier | pointer_type | ...)
    const typeNode = node.childForFieldName('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    // fallback: second named child is usually the type
    if (node.namedChildCount >= 2) {
      const t = node.namedChild(1);
      if (t) return extractSimpleTypeName(t) ?? t.text?.trim();
    }
    return undefined;
  },

  extractVisibility(node) {
    const name = node.childForFieldName('name');
    const text = name?.text;
    if (text && text.length > 0) {
      const first = text.charAt(0);
      return first === first.toUpperCase() && first !== first.toLowerCase() ? 'public' : 'package';
    }
    return 'package';
  },

  extractVisibilityForName(_node, name) {
    return goVisibilityForName(name);
  },

  isStatic(_node) {
    return false; // Go has no static fields
  },

  isReadonly(_node) {
    return false; // Go fields are not readonly
  },
};
