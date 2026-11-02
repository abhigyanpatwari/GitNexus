import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig, ClassLikeNodeLabel } from '../../class-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import {
  isZigFileStruct,
  ZIG_CONTAINER_TYPES,
  zigContainerLabel,
  zigContainerName,
} from '../../languages/zig/captures.js';

/**
 * Zig containers (struct/enum/union/opaque) are anonymous in the grammar:
 *
 *   const Point = struct { ... };
 *   pub fn List(comptime T: type) type { return struct { ... }; }
 *   fn build() void { const R = struct { ... }; sort(struct { fn lt … }.lt); }
 *
 * The identity is the binding name (first identifier of the parent
 * variable_declaration), the generic type constructor's name, or — for a
 * FUNCTION-LOCAL or ANONYMOUS container — a synthesized `host$Name` /
 * `host$N` (F8). `zigContainerName` is the single source shared with the
 * field/method extractors and the owner walk, so owner ids and node ids
 * agree by construction. Which of the (up to three) ZIG_QUERIES rules that
 * match one container gets to mint it is decided by the provider's
 * `shouldSkipDefinitionCapture` (`isZigRedundantContainerCapture`).
 */
const extractZigContainerName = (node: SyntaxNode, filePath?: string): string | undefined =>
  zigContainerName(node, filePath);

const extractZigContainerType = (node: SyntaxNode): ClassLikeNodeLabel | undefined => {
  // The file itself, when it declares top-level fields (file-struct); a
  // namespace-only file is not a type — `extract` then yields no symbol.
  if (node.type === 'source_file') return isZigFileStruct(node) ? 'Struct' : undefined;
  return zigContainerLabel(node);
};

export const zigClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Zig,
  typeDeclarationNodes: [...ZIG_CONTAINER_TYPES, 'source_file'],
  extractName: extractZigContainerName,
  extractType: extractZigContainerType,
};
