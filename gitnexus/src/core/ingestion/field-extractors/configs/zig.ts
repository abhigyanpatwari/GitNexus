import { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { FieldExtractionConfig } from '../generic.js';

/**
 * Zig containers (struct/enum/union) are anonymous in tree-sitter-zig; the
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
  typeDeclarationNodes: ['struct_declaration', 'enum_declaration', 'union_declaration'],
  fieldNodeTypes: ['container_field'],
  bodyNodeTypes: [],
  defaultVisibility: 'public',
  extractOwnerName: extractZigOwnerName,

  extractName(node) {
    const name = node.childForFieldName('name');
    return name?.text;
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
