// gitnexus/src/core/ingestion/field-extractors/configs/helpers.ts

/**
 * Shared AST-walking helpers used by multiple language configs.
 * Keeps individual config files small.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

// ---------------------------------------------------------------------------
// Modifier scanning
// ---------------------------------------------------------------------------

/**
 * Check whether any child of `node` (named or unnamed) has .text matching
 * one of the given `keywords`.
 */
export function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.text.trim() === keyword) return true;
  }
  return false;
}

/**
 * Check whether a named child of type `modifierType` contains `keyword`.
 * Useful for languages that group modifiers under a wrapper node
 * (e.g. Java 'modifiers', Kotlin 'modifiers').
 */
export function hasModifier(node: SyntaxNode, modifierType: string, keyword: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === modifierType) {
      for (let j = 0; j < child.childCount; j++) {
        const mod = child.child(j);
        if (mod && mod.text.trim() === keyword) return true;
      }
    }
  }
  return false;
}

/**
 * Return the first matching visibility keyword found either as a direct keyword
 * child or inside a modifier wrapper node.
 */
export function findVisibility(
  node: SyntaxNode,
  keywords: ReadonlySet<FieldVisibility>,
  defaultVis: FieldVisibility,
  modifierNodeType?: string,
): FieldVisibility {
  // Direct keyword children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const text = child?.text.trim() as FieldVisibility | undefined;
    if (text && (keywords as ReadonlySet<string>).has(text)) return text;
  }
  // Modifier wrapper
  if (modifierNodeType) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === modifierNodeType) {
        for (let j = 0; j < child.childCount; j++) {
          const mod = child.child(j);
          const modText = mod?.text.trim() as FieldVisibility | undefined;
          if (modText && (keywords as ReadonlySet<string>).has(modText)) return modText;
        }
      }
    }
  }
  return defaultVis;
}

// ---------------------------------------------------------------------------
// Name and type extraction
// ---------------------------------------------------------------------------

/**
 * Extract the text of the first named child whose type is in `types`.
 */
export function firstChildText(node: SyntaxNode, types: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.has(child.type)) return child.text;
  }
  return undefined;
}

/**
 * Extract the first named child node whose type is in `types`.
 */
export function firstChildOfType(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.has(child.type)) return child;
  }
  return null;
}

/**
 * Get type text from a named field on the node, using extractSimpleTypeName.
 * Falls back to raw .text of the field child if extractSimpleTypeName returns undefined.
 */
export function typeFromField(node: SyntaxNode, fieldName: string): string | undefined {
  const typeNode = node.childForFieldName(fieldName);
  if (!typeNode) return undefined;
  return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
}

/**
 * Walk named children looking for a type_annotation node and extract its type.
 */
export function typeFromAnnotation(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'type_annotation') {
      const inner = child.firstNamedChild;
      if (inner) return extractSimpleTypeName(inner) ?? inner.text?.trim();
    }
  }
  return undefined;
}

/**
 * Find the first descendant (depth-first, one level) matching one of the given types
 * and return its text via extractSimpleTypeName.
 */
export function typeFromDescendant(
  node: SyntaxNode,
  types: ReadonlySet<string>,
): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (types.has(child.type)) {
      return extractSimpleTypeName(child) ?? child.text?.trim();
    }
    // one more level
    for (let j = 0; j < child.namedChildCount; j++) {
      const grandchild = child.namedChild(j);
      if (grandchild && types.has(grandchild.type)) {
        return extractSimpleTypeName(grandchild) ?? grandchild.text?.trim();
      }
    }
  }
  return undefined;
}
