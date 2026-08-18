import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig, VariableVisibility } from '../../variable-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { hasZigVisibilityKeyword } from '../../export-detection.js';
import { isZigContainerOrImportBinding } from '../../languages/zig/captures.js';

/**
 * Zig variable extraction.
 *
 * tree-sitter-zig uses a single `variable_declaration` node for both `const`
 * and `var` bindings. The keyword is exposed as an unnamed token child
 * (`type === 'const'` or `type === 'var'`).
 *
 * Excludes variable_declarations whose value is a struct/enum/union or an
 * `@import(...)` builtin — those are handled by the class extractor / import
 * pipeline, and a Variable record beside the Struct/Enum/Union node (or the
 * import edge) would be a duplicate. `extractName` returns undefined for them,
 * which is the generic extractor's skip signal (see `generic.ts`, and Python's
 * broad `expression_statement` config for the same pattern).
 */

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
    if (isZigContainerOrImportBinding(node)) return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier') return child.text;
    }
    return undefined;
  },

  extractType(node) {
    // tree-sitter-zig 1.1.2 exposes the annotation as the `type:` field of
    // variable_declaration (its only field; verified by AST dump: `const p:
    // *Foo = …` → `pointer_type [type]`, `extern var f: T;` → `identifier
    // [type]`). Reading the field covers every annotation shape (builtin,
    // identifier, pointer/optional/slice/array/fn types) and, just as
    // importantly, never mistakes an initializer for a type: `const f =
    // target;` has no `type:` field, so it is untyped — the old positional
    // fallback returned `target` as its type.
    return node.childForFieldName('type')?.text?.trim();
  },

  extractVisibility(node): VariableVisibility {
    return hasZigVisibilityKeyword(node) ? 'public' : 'private';
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
