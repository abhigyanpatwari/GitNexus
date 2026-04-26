// gitnexus/src/core/ingestion/class-extractors/configs/zig.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { ClassExtractionConfig, ClassLikeNodeLabel } from '../../class-types.js';

/**
 * Find the "type expression" child of a Zig variable_declaration.
 * Zig binds anonymous container types to variables:
 *   const Pioneer = struct { ... };
 *   const State = enum { ... };
 *   const Tag = union(enum) { ... };
 * The container declaration is a child of the variable_declaration node,
 * not a top-level node like Rust's struct_item.
 */
function findContainerTypeChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (
      child.type === 'struct_declaration' ||
      child.type === 'enum_declaration' ||
      child.type === 'union_declaration'
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Zig class extraction config.
 *
 * `variable_declaration` is the type-bearing node when its RHS is a
 * struct/enum/union. The variable's `identifier` provides the type name.
 */
export const zigClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Zig,
  // Only variable_declaration is treated as a type declaration — the actual
  // shape (Struct/Enum/Class) is decided by extractType.
  typeDeclarationNodes: ['variable_declaration'],
  ancestorScopeNodeTypes: ['variable_declaration'],

  extractName(node: SyntaxNode): string | undefined {
    if (node.type !== 'variable_declaration') return undefined;
    // Only emit a name if this variable_declaration actually wraps a container type.
    if (!findContainerTypeChild(node)) return undefined;
    // First named identifier child holds the bound name.
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'identifier') return c.text;
    }
    return undefined;
  },

  extractType(node: SyntaxNode): ClassLikeNodeLabel | undefined {
    if (node.type !== 'variable_declaration') return undefined;
    const container = findContainerTypeChild(node);
    if (!container) return undefined;
    if (container.type === 'struct_declaration') return 'Struct';
    if (container.type === 'enum_declaration') return 'Enum';
    if (container.type === 'union_declaration') return 'Class';
    return undefined;
  },

  // For nested containers, the enclosing variable_declaration's bound name
  // contributes the scope segment. We extract that identifier here.
  extractScopeSegments(scopeNode: SyntaxNode): string[] | undefined {
    if (scopeNode.type !== 'variable_declaration') return undefined;
    if (!findContainerTypeChild(scopeNode)) return [];
    for (let i = 0; i < scopeNode.namedChildCount; i++) {
      const c = scopeNode.namedChild(i);
      if (c?.type === 'identifier') return [c.text];
    }
    return [];
  },
};
