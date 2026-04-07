// gitnexus/src/core/ingestion/method-extractors/configs/swift.ts
// Verified against tree-sitter-swift 0.6.0

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { findVisibility, hasKeyword, hasModifier } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Swift helpers
// ---------------------------------------------------------------------------

const SWIFT_VIS = new Set<MethodVisibility>([
  'public',
  'private',
  'fileprivate',
  'internal',
  'open',
]);

/**
 * Extract the method name from a function_declaration or protocol_function_declaration.
 *
 * In tree-sitter-swift, the name is stored in a `simple_identifier` child
 * (not a 'name' field) on both function_declaration and protocol_function_declaration.
 */
function extractSwiftName(node: SyntaxNode): string | undefined {
  // Try field-based name first
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;

  // Walk named children for simple_identifier (the function name)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'simple_identifier') return child.text;
  }
  return undefined;
}

/**
 * Extract the return type from a Swift function declaration.
 *
 * In tree-sitter-swift, the return type appears in a `type_annotation` child
 * that follows the parameter list (after `->` in source). It may also appear
 * as a direct type child (user_type, optional_type, tuple_type, array_type).
 */
function extractSwiftReturnType(node: SyntaxNode): string | undefined {
  // Look for the return type — typically the last type_annotation or a type node
  // that appears after the parameter list.
  // tree-sitter-swift places the return type inside a type child after '->'
  let seenParams = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'parameter') {
      seenParams = true;
      continue;
    }
    // The parameter list may be unnamed children; track when we pass ')'
    if (seenParams || child.type === 'type_annotation') {
      if (child.type === 'type_annotation') {
        const inner = child.firstNamedChild;
        if (inner) return inner.text?.trim();
      }
      if (
        child.type === 'user_type' ||
        child.type === 'optional_type' ||
        child.type === 'tuple_type' ||
        child.type === 'array_type' ||
        child.type === 'dictionary_type' ||
        child.type === 'function_type'
      ) {
        return child.text?.trim();
      }
    }
  }

  // Fallback: scan all children (named + unnamed) for '->' then grab the next named child
  let seenArrow = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && child.text.trim() === '->') {
      seenArrow = true;
      continue;
    }
    if (seenArrow && child.isNamed) {
      return child.text?.trim();
    }
  }

  return undefined;
}

/**
 * Extract parameters from a Swift function declaration.
 *
 * In tree-sitter-swift, parameters are `parameter` named children directly on
 * the function_declaration node. Each parameter has:
 *   - An external name (label) and/or internal name as simple_identifier children
 *   - A type_annotation child containing the type
 *   - An optional default value after '='
 *   - A possible `...` for variadic parameters
 */
function extractSwiftParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  // In tree-sitter-swift 0.6.0, parameters are direct children of function_declaration.
  // Default value tokens ('=', literal) are siblings of the parameter node at the
  // function_declaration level, not children of the parameter node.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child?.isNamed || child.type !== 'parameter') continue;

    // Extract parameter name — the last simple_identifier is the internal name
    let paramName: string | undefined;
    for (let j = 0; j < child.namedChildCount; j++) {
      const part = child.namedChild(j);
      if (part?.type === 'simple_identifier') {
        paramName = part.text;
      }
    }
    if (!paramName) continue;

    // Extract type — tree-sitter-swift uses user_type (not type_annotation)
    let typeName: string | null = null;
    let rawTypeName: string | null = null;
    for (let j = 0; j < child.namedChildCount; j++) {
      const part = child.namedChild(j);
      if (part?.type === 'user_type' || part?.type === 'type_annotation') {
        rawTypeName = part.text?.trim() ?? null;
        const inner = part.firstNamedChild;
        if (inner) {
          typeName = extractSimpleTypeName(inner) ?? inner.text?.trim() ?? null;
        } else {
          typeName = rawTypeName;
        }
        break;
      }
      // Handle built-in types (array_type, dictionary_type, optional_type, tuple_type)
      if (part?.type.endsWith('_type') && part.type !== 'simple_identifier') {
        rawTypeName = part.text?.trim() ?? null;
        typeName = extractSimpleTypeName(part) ?? rawTypeName;
        break;
      }
    }

    // Check for default value: '=' token appears as a sibling after the parameter node
    let isOptional = false;
    const nextSibling = node.child(i + 1);
    if (nextSibling && !nextSibling.isNamed && nextSibling.text.trim() === '=') {
      isOptional = true;
    }

    // Check for variadic: '...' token among parameter children
    let isVariadic = false;
    for (let j = 0; j < child.childCount; j++) {
      const c = child.child(j);
      if (c && c.text.trim() === '...') {
        isVariadic = true;
        break;
      }
    }

    params.push({
      name: paramName,
      type: typeName,
      rawType: rawTypeName,
      isOptional,
      isVariadic,
    });
  }

  return params;
}

/**
 * Check if a method is inside a protocol.
 *
 * A protocol_function_declaration is always abstract. For function_declaration
 * inside a protocol_body (if it appears there), it's also abstract when it has
 * no body.
 */
function isSwiftAbstract(node: SyntaxNode, ownerNode: SyntaxNode): boolean {
  // protocol_function_declaration nodes are inherently abstract
  if (node.type === 'protocol_function_declaration') return true;

  // function_declaration inside a protocol is abstract if it has no body
  if (ownerNode.type === 'protocol_declaration') {
    const body = node.childForFieldName('body');
    if (!body) {
      // Also check for function_body named child
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'function_body') return false;
      }
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Collect attribute nodes from a Swift function declaration.
 *
 * In tree-sitter-swift, attributes appear as `attribute` named children
 * directly on the function_declaration node, or inside a `modifiers` wrapper.
 * Each attribute node text starts with '@'.
 */
function extractSwiftAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === 'attribute') {
      const text = child.text?.trim();
      if (text) {
        // Normalize: strip arguments, keep just the name
        // e.g. "@objc(myMethod)" -> "@objc", "@available(iOS 13, *)" -> "@available"
        const match = text.match(/^@(\w+)/);
        if (match) {
          annotations.push('@' + match[1]);
        } else {
          annotations.push(text);
        }
      }
    }

    // Also check inside modifiers wrapper
    if (child.type === 'modifiers') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const mod = child.namedChild(j);
        if (mod?.type === 'attribute') {
          const text = mod.text?.trim();
          if (text) {
            const match = text.match(/^@(\w+)/);
            if (match) {
              annotations.push('@' + match[1]);
            } else {
              annotations.push(text);
            }
          }
        }
      }
    }
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Swift config
// ---------------------------------------------------------------------------

export const swiftMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Swift,

  // tree-sitter-swift 0.6.0 may use class_declaration for classes, structs, enums, extensions,
  // and actors — but this cannot be verified until the grammar installs on Node 22+.
  // TODO: Verify struct_declaration, enum_declaration, extension_declaration, actor_declaration
  // node types once tree-sitter-swift loads on Node 22, and add them here if they are distinct.
  // protocol_declaration is a separate, confirmed node type.
  typeDeclarationNodes: ['class_declaration', 'protocol_declaration'],

  // function_declaration for class/struct methods, protocol_function_declaration for protocol methods
  methodNodeTypes: ['function_declaration', 'protocol_function_declaration'],

  bodyNodeTypes: ['class_body', 'protocol_body'],

  extractName: extractSwiftName,
  extractReturnType: extractSwiftReturnType,
  extractParameters: extractSwiftParameters,

  extractVisibility(node) {
    return findVisibility(node, SWIFT_VIS, 'internal', 'modifiers');
  },

  isStatic(node) {
    return (
      hasKeyword(node, 'static') ||
      hasKeyword(node, 'class') ||
      hasModifier(node, 'modifiers', 'static') ||
      hasModifier(node, 'modifiers', 'class')
    );
  },

  isAbstract: isSwiftAbstract,

  isFinal(node) {
    return hasKeyword(node, 'final') || hasModifier(node, 'modifiers', 'final');
  },

  isAsync(node) {
    return hasKeyword(node, 'async') || hasModifier(node, 'modifiers', 'async');
  },

  isOverride(node) {
    return hasKeyword(node, 'override') || hasModifier(node, 'modifiers', 'override');
  },

  extractAnnotations: extractSwiftAnnotations,
};
