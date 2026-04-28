// gitnexus/src/core/ingestion/method-extractors/configs/rust.ts
// Verified against tree-sitter-rust 0.23.1

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Rust helpers
// ---------------------------------------------------------------------------

/**
 * Extract method name from function_item or function_signature_item.
 * Both use a `name` field containing an identifier.
 */
function extractRustMethodName(node: SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}

/**
 * Extract return type from the `return_type` field.
 * tree-sitter-rust puts the return type (after `->`) as the `return_type` field.
 */
function extractRustReturnType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('return_type');
  if (!typeNode) return undefined;
  return typeNode.text?.trim();
}

/**
 * Extract parameters, skipping the self_parameter (handled by extractReceiverType).
 *
 * Rust parameters use `pattern` and `type` fields:
 *   parameter { pattern: identifier, type: primitive_type }
 */
function extractRustParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    // Skip self_parameter — it is the receiver, not a regular parameter
    if (param.type === 'self_parameter') continue;

    if (param.type === 'parameter') {
      const patternNode = param.childForFieldName('pattern');
      const typeNode = param.childForFieldName('type');
      params.push({
        name: patternNode?.text ?? '?',
        type: typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null) : null,
        rawType: typeNode?.text?.trim() ?? null,
        isOptional: false,
        isVariadic: false,
      });
    }
  }
  return params;
}

/**
 * Detect visibility from visibility_modifier named child.
 * `pub`, `pub(crate)`, `pub(super)`, `pub(in path)` → public.
 * Absence → private (Rust default).
 */
function extractRustVisibility(node: SyntaxNode): MethodVisibility {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'visibility_modifier') return 'public';
  }
  return 'private';
}

/**
 * Detect receiver type from the first parameter if it is a self_parameter.
 *
 * Variants:
 *   - `self`       → "self"
 *   - `&self`      → "&self"
 *   - `&mut self`  → "&mut self"
 *   - `mut self`   → "mut self"
 *   - `self: Box<Self>` → "Box<Self>" (explicit self type)
 */
function extractRustReceiverType(node: SyntaxNode): string | undefined {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return undefined;
  const first = paramList.namedChild(0);
  if (!first || first.type !== 'self_parameter') return undefined;
  return first.text;
}

/**
 * Check whether a function_item has the `async` keyword.
 * tree-sitter-rust wraps it in a `function_modifiers` named child.
 */
function isRustAsync(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'function_modifiers' && child.text.includes('async')) return true;
  }
  return false;
}

/**
 * Extract attributes from preceding sibling attribute_item nodes.
 *
 * In tree-sitter-rust, `#[inline]` is an `attribute_item` sibling that precedes
 * the function_item in the declaration_list, not a child of the function_item.
 */
function extractRustAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'attribute_item') {
      annotations.unshift(sibling.text);
    } else {
      // Stop at the first non-attribute sibling — attributes are contiguous
      break;
    }
    sibling = sibling.previousNamedSibling;
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Rust config
// ---------------------------------------------------------------------------

// Rust methods live inside `impl` blocks (concrete implementations) or
// `trait` blocks (trait definitions with required/default methods).
//
// `impl_item` body contains `function_item` nodes for concrete methods.
// `trait_item` body contains `function_item` (default methods) and
// `function_signature_item` (required/abstract methods without a body).
//
// ownerName resolution: `impl_item` has no `name` field — the generic
// extractor falls back to the first `type_identifier` child, which is the
// implementing type (e.g. `impl MyStruct { ... }` → "MyStruct").
// `trait_item` uses the standard `name` field.
//
// Known gaps:
//   - Macro-generated methods (e.g. derive) are not visible in the AST.
//   - Unsafe methods are not distinguished (no isUnsafe field in schema).
export const rustMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Rust,
  typeDeclarationNodes: ['impl_item', 'trait_item'],
  methodNodeTypes: ['function_item', 'function_signature_item'],
  bodyNodeTypes: ['declaration_list'],

  // For `impl Trait for Struct`, resolve owner to the concrete Struct (after `for`).
  // For plain `impl Struct`, resolve to Struct (first type_identifier).
  // For `trait Foo`, let the default name-field resolution handle it.
  extractOwnerName(node) {
    if (node.type !== 'impl_item') return undefined;
    const children = node.children ?? [];
    const forIdx = children.findIndex((c: SyntaxNode) => c.text === 'for');
    if (forIdx !== -1) {
      // impl Trait for Struct — pick the type after `for`
      const typeNode = children
        .slice(forIdx + 1)
        .find(
          (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier',
        );
      if (typeNode) return typeNode.text;
    }
    // Plain `impl Struct` — pick the first type_identifier
    const first = children.find((c: SyntaxNode) => c.type === 'type_identifier');
    return first?.text;
  },

  extractName: extractRustMethodName,
  extractReturnType: extractRustReturnType,
  extractParameters: extractRustParameters,
  extractVisibility: extractRustVisibility,

  isStatic(node) {
    // A Rust method is an "associated function" (static) if it lacks a
    // self_parameter as first parameter.
    const paramList = node.childForFieldName('parameters');
    if (!paramList) return true;
    const first = paramList.namedChild(0);
    return !first || first.type !== 'self_parameter';
  },

  isAbstract(node, ownerNode) {
    // Only trait methods without a body (function_signature_item) are abstract.
    // function_signature_item never has a body field.
    if (ownerNode.type === 'trait_item' && node.type === 'function_signature_item') {
      return true;
    }
    return false;
  },

  isFinal() {
    // Rust has no `final` concept — all methods are effectively sealed
    // (traits cannot be "overridden" the way Java methods can).
    return false;
  },

  extractAnnotations: extractRustAnnotations,
  extractReceiverType: extractRustReceiverType,
  isAsync: isRustAsync,
};
