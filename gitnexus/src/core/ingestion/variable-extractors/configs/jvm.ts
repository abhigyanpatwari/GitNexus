// gitnexus/src/core/ingestion/variable-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { VariableExtractionConfig } from '../../variable-types.js';
import type { VariableVisibility } from '../../variable-types.js';
import { hasModifier } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Java variable extraction config.
 *
 * Java does not have true module-level variables — all declarations are
 * class-scoped. However, `static final` fields at class scope act like
 * constants. These are already handled by the field extractor. This config
 * covers any rare local_variable_declaration captures at file scope
 * (e.g., in scripts or top-level code blocks in JShell).
 */
export const javaVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Java,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['local_variable_declaration'],

  extractName(node) {
    const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    return name?.type === 'identifier' ? name.text : undefined;
  },

  extractType(node) {
    const typeNode = node.childForFieldName('type');
    if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    return undefined;
  },

  extractVisibility(node): VariableVisibility {
    if (hasModifier(node, 'modifiers', 'public')) return 'public';
    if (hasModifier(node, 'modifiers', 'private')) return 'private';
    if (hasModifier(node, 'modifiers', 'protected')) return 'protected';
    return 'package';
  },

  isConst(node) {
    return hasModifier(node, 'modifiers', 'final');
  },

  isStatic(node) {
    return hasModifier(node, 'modifiers', 'static');
  },

  isMutable(node) {
    return !hasModifier(node, 'modifiers', 'final');
  },
};

/**
 * Kotlin variable extraction config.
 *
 * Kotlin has true top-level val/var declarations outside classes.
 * tree-sitter-kotlin uses 'property_declaration' for both.
 */
export const kotlinVariableConfig: VariableExtractionConfig = {
  language: SupportedLanguages.Kotlin,
  constNodeTypes: [],
  staticNodeTypes: [],
  variableNodeTypes: ['property_declaration'],

  extractName(node) {
    // property_declaration → variable_declaration → simple_identifier
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declaration') {
        const ident = child.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier');
        return ident?.text;
      }
    }
    return undefined;
  },

  extractType(node) {
    // Look for type annotation in variable_declaration child
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declaration') {
        const typeNode = child.namedChildren.find(
          (c: SyntaxNode) => c.type === 'user_type' || c.type === 'nullable_type',
        );
        if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(node): VariableVisibility {
    if (hasModifier(node, 'modifiers', 'public')) return 'public';
    if (hasModifier(node, 'modifiers', 'private')) return 'private';
    if (hasModifier(node, 'modifiers', 'protected')) return 'protected';
    if (hasModifier(node, 'modifiers', 'internal')) return 'internal';
    return 'public'; // Kotlin default is public
  },

  isConst(node) {
    // val is immutable; also check for `const` modifier
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.text === 'val') return true;
    }
    return hasModifier(node, 'modifiers', 'const');
  },

  isStatic(_node) {
    // Top-level Kotlin properties are not static in the Java sense
    return false;
  },

  isMutable(node) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.text === 'var') return true;
    }
    return false;
  },
};
