import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { NamedBinding } from './types.js';

/**
 * Zig named-binding extraction.
 *
 * The capture in tree-sitter-queries.ts pins `@import` as the import node
 * (the builtin_function call). The enclosing variable_declaration gives us
 * the local name:
 *
 *   const std = @import("std");          → local "std", exported = "std"
 *   const ArrayList = std.ArrayList;     → field access alias chain (local
 *                                           "ArrayList", exported "ArrayList")
 *
 * We treat the bound variable name as a per-symbol binding — this matches
 * `importSemantics: 'named'` and ensures cross-file references through
 * an aliased identifier resolve to the right module.
 */
export function extractZigNamedBindings(importNode: SyntaxNode): NamedBinding[] | undefined {
  // The query captures the builtin_function (@import call). Walk up to the
  // enclosing variable_declaration to find the bound local name.
  let current: SyntaxNode | null = importNode;
  while (current && current.type !== 'variable_declaration') {
    current = current.parent;
  }
  if (!current) return undefined;

  // First named identifier child is the bound name.
  for (let i = 0; i < current.namedChildCount; i++) {
    const c = current.namedChild(i);
    if (c?.type === 'identifier') {
      return [{ local: c.text, exported: c.text }];
    }
  }
  return undefined;
}
