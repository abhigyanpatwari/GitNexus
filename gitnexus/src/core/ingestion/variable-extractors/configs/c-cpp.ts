// gitnexus/src/core/ingestion/variable-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { hasKeyword } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * C/C++ variable extraction config.
 *
 * Handles global/namespace-scoped variable declarations:
 * - `int x = 5;`
 * - `const int MAX = 100;`
 * - `static int counter = 0;`
 * - `constexpr int SIZE = 10;` (C++)
 * - `extern int shared;`
 *
 * tree-sitter-c/cpp uses declaration for variable declarations.
 */

function extractCVarName(node: SyntaxNode): string | undefined {
  // declaration → declarator (init_declarator or identifier)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'init_declarator') {
      const declarator = child.childForFieldName('declarator');
      if (declarator?.type === 'identifier') return declarator.text;
      if (declarator?.type === 'pointer_declarator') {
        const inner = declarator.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
        return inner?.text;
      }
    }
    if (child?.type === 'identifier') return child.text;
  }
  return undefined;
}

/**
 * Locate the `structured_binding_declarator` inside a `declaration` node, if any.
 *
 * C++ structured bindings (`auto [a, b] = pair;`) parse as:
 *   declaration → init_declarator → structured_binding_declarator → identifier+
 * The reference form (`auto& [x, y] = tup;`) wraps it one level deeper:
 *   declaration → init_declarator → reference_declarator → structured_binding_declarator
 */
function findStructuredBindingDeclarator(node: SyntaxNode): SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== 'init_declarator') continue;
    const declarator = child.childForFieldName('declarator');
    if (declarator?.type === 'structured_binding_declarator') return declarator;
    // `auto& [x, y]` → reference_declarator wraps the structured_binding_declarator.
    if (declarator?.type === 'reference_declarator') {
      const inner = declarator.namedChildren.find(
        (c: SyntaxNode) => c.type === 'structured_binding_declarator',
      );
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * Extract every bound name from a C/C++ declaration.
 *
 * For a structured binding `auto [a, b] = ...;` this returns each bound
 * identifier (`['a', 'b']`); the binding's `structured_binding_declarator`
 * lists one `identifier` per name. For an ordinary single-name declaration
 * (`int n = 0;`) it falls back to the single name extractor so behaviour is
 * unchanged (issue #1919 F9).
 */
function extractCVarNames(node: SyntaxNode): string[] {
  const binding = findStructuredBindingDeclarator(node);
  if (binding !== undefined) {
    const names: string[] = [];
    for (let i = 0; i < binding.namedChildCount; i++) {
      const child = binding.namedChild(i);
      if (child?.type === 'identifier') names.push(child.text);
    }
    return names;
  }

  const single = extractCVarName(node);
  return single !== undefined ? [single] : [];
}

function extractCVarType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  // Fallback: first primitive_type or type_identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child?.type === 'primitive_type' ||
      child?.type === 'type_identifier' ||
      child?.type === 'sized_type_specifier'
    ) {
      return child.text?.trim();
    }
  }
  return undefined;
}

const shared: Omit<VariableExtractionConfig, 'language'> = {
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['declaration'],

  extractName: extractCVarName,
  extractNames: extractCVarNames,
  extractType: extractCVarType,

  extractVisibility(node): VariableVisibility {
    // C/C++ visibility is file-scoped by default (static = file-private)
    if (hasKeyword(node, 'static')) return 'private';
    if (hasKeyword(node, 'extern')) return 'public';
    return 'public';
  },

  isConst(node) {
    return hasKeyword(node, 'const') || hasKeyword(node, 'constexpr');
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isMutable(node) {
    return !hasKeyword(node, 'const') && !hasKeyword(node, 'constexpr');
  },
};

export const cVariableConfig: VariableExtractionConfig = {
  ...shared,
  language: SupportedLanguages.C,
};

export const cppVariableConfig: VariableExtractionConfig = {
  ...shared,
  language: SupportedLanguages.CPlusPlus,
};
