import { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { FieldExtractionConfig } from '../generic.js';
import { ZIG_CONTAINER_TYPES } from '../../languages/zig/captures.js';

/**
 * Zig containers (struct/enum/union/opaque) are anonymous in tree-sitter-zig; the
 * binding name is the first identifier child of the parent variable_declaration.
 */
const extractZigOwnerName = (node: SyntaxNode): string | undefined => {
  const parent = node.parent;
  if (!parent || parent.type !== 'variable_declaration') return undefined;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child?.type === 'identifier') return child.text;
  }
  return undefined;
};

/**
 * Container fields appear as direct children of struct_declaration /
 * enum_declaration / union_declaration — there is no separate body wrapper
 * in this grammar, so `bodyNodeTypes` is empty and the generic factory's
 * "iterate immediate children" pass picks them up.
 */
export const zigFieldConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Zig,
  typeDeclarationNodes: [...ZIG_CONTAINER_TYPES],
  fieldNodeTypes: ['container_field'],
  bodyNodeTypes: [],
  defaultVisibility: 'public',
  extractOwnerName: extractZigOwnerName,

  extractName(node) {
    const name = node.childForFieldName('name');
    // An empty container body (`struct {}`, `opaque {}`) is recovered by
    // tree-sitter-zig 1.1.2 as one container_field with a zero-width MISSING
    // identifier. Not a field — declining here keeps it out of the field map.
    if (name === null || name.text.length === 0) return undefined;
    return name.text;
  },

  extractType(node) {
    const typeNode = node.childForFieldName('type');
    return typeNode?.text?.trim();
  },

  extractVisibility() {
    // Zig has no per-field visibility — fields inherit the container's
    // module-level visibility. Treat as public; the export checker decides
    // what the *container* exposes.
    return 'public';
  },

  isStatic() {
    return false;
  },

  isReadonly() {
    return false;
  },
};
