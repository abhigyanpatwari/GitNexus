import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig, ClassLikeNodeLabel } from '../../class-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { ZIG_CONTAINER_TYPES, zigContainerName } from '../../languages/zig/captures.js';

/**
 * Zig containers (struct/enum/union/opaque) are anonymous in the grammar:
 *
 *   const Point = struct { ... };
 *   pub fn List(comptime T: type) type { return struct { ... }; }
 *
 * The binding name is the first identifier child of the parent
 * variable_declaration, or the generic type constructor's name —
 * `zigContainerName` is the single source shared with the field/method
 * extractors so owner ids and node ids agree by construction.
 */
const extractZigContainerName = (node: SyntaxNode): string | undefined => zigContainerName(node);

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
