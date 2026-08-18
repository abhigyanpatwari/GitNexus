import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig, ClassLikeNodeLabel } from '../../class-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { ZIG_CONTAINER_TYPES } from '../../languages/zig/captures.js';

/**
 * Zig containers (struct/enum/union/opaque) are anonymous in the grammar:
 *
 *   const Point = struct { ... };
 *
 * The binding name is the first identifier child of the parent
 * variable_declaration. Walk up one level to find it.
 */
const extractZigContainerName = (node: SyntaxNode): string | undefined => {
  const parent = node.parent;
  if (!parent || parent.type !== 'variable_declaration') return undefined;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child?.type === 'identifier') return child.text;
  }
  return undefined;
};

const extractZigContainerType = (node: SyntaxNode): ClassLikeNodeLabel | undefined => {
  if (node.type === 'struct_declaration') return 'Struct';
  if (node.type === 'enum_declaration') return 'Enum';
  if (node.type === 'union_declaration') return 'Union';
  // `opaque {}` is a fieldless container that may own methods — Struct is the
  // closest class-like label (rationale in ZIG_QUERIES).
  if (node.type === 'opaque_declaration') return 'Struct';
  return undefined;
};

export const zigClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Zig,
  typeDeclarationNodes: [...ZIG_CONTAINER_TYPES],
  extractName: extractZigContainerName,
  extractType: extractZigContainerType,
};
