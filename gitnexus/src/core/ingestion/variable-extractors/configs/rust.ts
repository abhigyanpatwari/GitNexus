// gitnexus/src/core/ingestion/variable-extractors/configs/rust.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Rust variable extraction config.
 *
 * Rust has module-scoped const, static, and let declarations:
 * - `const MAX_SIZE: usize = 100;`
 * - `static COUNTER: AtomicUsize = AtomicUsize::new(0);`
 * - `static mut BUFFER: Vec<u8> = Vec::new();`
 * - `let x = 5;` (block-scoped, but included for completeness)
 *
 * tree-sitter-rust uses:
 * - const_item → identifier, type
 * - static_item → identifier, type
 * - let_declaration → identifier, type
 */

function hasVisibilityModifier(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'visibility_modifier') return true;
  }
  return false;
}

function hasMutKeyword(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.text === 'mut') return true;
  }
  return false;
}

export const rustVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Rust,
  constNodeTypes: ['const_item'],
  staticNodeTypes: ['static_item'],
  variableNodeTypes: ['let_declaration'],

  extractName(node) {
    const name = node.childForFieldName('name');
    if (name) return name.text;
    // Fallback: first identifier child
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier') return child.text;
    }
    return undefined;
  },

  extractType(node) {
    const typeNode = node.childForFieldName('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    return undefined;
  },

  extractVisibility(node): VariableVisibility {
    return hasVisibilityModifier(node) ? 'public' : 'private';
  },

  isConst(node) {
    return node.type === 'const_item';
  },

  isStatic(node) {
    return node.type === 'static_item';
  },

  isMutable(node) {
    if (node.type === 'const_item') return false;
    if (node.type === 'static_item') return hasMutKeyword(node);
    // let_declaration: check for mut keyword
    if (node.type === 'let_declaration') return hasMutKeyword(node);
    return true;
  },
};
