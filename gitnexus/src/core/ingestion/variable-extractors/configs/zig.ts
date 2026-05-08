import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig, VariableVisibility } from '../../variable-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Zig variable extraction.
 *
 * tree-sitter-zig uses a single `variable_declaration` node for both `const`
 * and `var` bindings. The keyword is exposed as an unnamed token child
 * (`type === 'const'` or `type === 'var'`).
 *
 * Excludes variable_declarations whose value is a struct/enum/union or an
 * `@import(...)` builtin — those are handled by the class extractor / import
 * pipeline. The exclusion is by-effect rather than by-config: when one of
 * those values is present, the surrounding pipeline labels the node as
 * Struct/Enum/Import-edge and the variable record is redundant.
 */

const hasPubKeyword = (node: SyntaxNode): boolean => {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'pub') return true;
  }
  return false;
};

const isVarKeyword = (node: SyntaxNode): boolean => {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'var') return true;
  }
  return false;
};

export const zigVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Zig,
  constNodeTypes: ['variable_declaration'],
  staticNodeTypes: [],
  variableNodeTypes: [],

  extractName(node) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier') return child.text;
    }
    return undefined;
  },

  extractType(node) {
    // type annotation appears as a `builtin_type` / `identifier` after the `:`.
    // tree-sitter-zig models the annotation as an unnamed-token-prefixed child;
    // the simplest portable accessor is childForFieldName('type'), which the
    // grammar exposes for parameters and function returns. Variable
    // declarations don't expose a `type` field in 1.1.2 — fall back to
    // scanning for the first builtin_type child after the binding identifier.
    const typeNode = node.childForFieldName('type');
    if (typeNode) return typeNode.text?.trim();
    let seenIdent = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (!seenIdent) {
        if (child.type === 'identifier') seenIdent = true;
        continue;
      }
      if (child.type === 'builtin_type' || child.type === 'identifier') {
        return child.text?.trim();
      }
      // Non-type expression (initializer) reached — no type annotation.
      return undefined;
    }
    return undefined;
  },

  extractVisibility(node): VariableVisibility {
    return hasPubKeyword(node) ? 'public' : 'private';
  },

  isConst(node) {
    return !isVarKeyword(node);
  },

  isStatic() {
    return false;
  },

  isMutable(node) {
    return isVarKeyword(node);
  },
};
