/**
 * Export Detection
 *
 * Determines whether a symbol (function, class, etc.) is exported/public
 * in its language. This is a pure function — safe for use in worker threads.
 *
 * Shared between parse-worker.ts (worker pool) and parsing-processor.ts (sequential fallback).
 */

import { findSiblingChild, type SyntaxNode } from './utils/ast-helpers.js';

/** Handler type: given a node and symbol name, return true if the symbol is exported/public. */
export type ExportChecker = (node: SyntaxNode, name: string) => boolean;

// ============================================================================
// Per-language export checkers
// ============================================================================

/** JS/TS: walk ancestors looking for export_statement or export_specifier. */
export const tsExportChecker: ExportChecker = (node, _name) => {
  let current: SyntaxNode | null = node;
  while (current) {
    const type = current.type;
    if (
      type === 'export_statement' ||
      type === 'export_specifier' ||
      (type === 'lexical_declaration' && current.parent?.type === 'export_statement')
    ) {
      return true;
    }
    // Fallback: check if node text starts with 'export ' for edge cases
    if (current.text?.startsWith('export ')) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/** Python: public if no leading underscore (convention). */
export const pythonExportChecker: ExportChecker = (_node, name) => !name.startsWith('_');

/** Java: check for 'public' modifier — modifiers are siblings of the name node, not parents. */
export const javaExportChecker: ExportChecker = (node, _name) => {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.parent) {
      const parent = current.parent;
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child?.type === 'modifiers' && child.text?.includes('public')) {
          return true;
        }
      }
      if (parent.type === 'method_declaration' || parent.type === 'constructor_declaration') {
        if (parent.text?.trimStart().startsWith('public')) {
          return true;
        }
      }
    }
    current = current.parent;
  }
  return false;
};

/** C# declaration node types for sibling modifier scanning. */
const CSHARP_DECL_TYPES = new Set([
  'method_declaration',
  'local_function_statement',
  'constructor_declaration',
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'enum_declaration',
  'record_declaration',
  'record_struct_declaration',
  'record_class_declaration',
  'delegate_declaration',
  'property_declaration',
  'field_declaration',
  'event_declaration',
  'namespace_declaration',
  'file_scoped_namespace_declaration',
]);

/**
 * C#: modifier nodes are SIBLINGS of the name node inside the declaration.
 * Walk up to the declaration node, then scan its direct children.
 */
export const csharpExportChecker: ExportChecker = (node, _name) => {
  let current: SyntaxNode | null = node;
  while (current) {
    if (CSHARP_DECL_TYPES.has(current.type)) {
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child?.type === 'modifier' && child.text === 'public') return true;
      }
      return false;
    }
    current = current.parent;
  }
  return false;
};

/** Go: uppercase first letter = exported. */
export const goExportChecker: ExportChecker = (_node, name) => {
  if (name.length === 0) return false;
  const first = name[0];
  return first === first.toUpperCase() && first !== first.toLowerCase();
};

/** Rust declaration node types for sibling visibility_modifier scanning. */
const RUST_DECL_TYPES = new Set([
  'function_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'impl_item',
  'union_item',
  'type_item',
  'const_item',
  'static_item',
  'mod_item',
  'use_declaration',
  'associated_type',
  'function_signature_item',
]);

/**
 * Rust: visibility_modifier is a SIBLING of the name node within the declaration node
 * (function_item, struct_item, etc.), not a parent. Walk up to the declaration node,
 * then scan its direct children.
 */
export const rustExportChecker: ExportChecker = (node, _name) => {
  let current: SyntaxNode | null = node;
  while (current) {
    if (RUST_DECL_TYPES.has(current.type)) {
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child?.type === 'visibility_modifier' && child.text?.startsWith('pub')) return true;
      }
      return false;
    }
    current = current.parent;
  }
  return false;
};

/**
 * Kotlin: default visibility is public (unlike Java).
 * visibility_modifier is inside modifiers, a sibling of the name node within the declaration.
 */
export const kotlinExportChecker: ExportChecker = (node, _name) => {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.parent) {
      const visMod = findSiblingChild(current.parent, 'modifiers', 'visibility_modifier');
      if (visMod) {
        const text = visMod.text;
        if (text === 'private' || text === 'internal' || text === 'protected') return false;
        if (text === 'public') return true;
      }
    }
    current = current.parent;
  }
  // No visibility modifier = public (Kotlin default)
  return true;
};

/**
 * C/C++: functions without 'static' storage class have external linkage by default,
 * making them globally accessible (equivalent to exported). Only functions explicitly
 * marked 'static' are file-scoped (not exported). C++ anonymous namespaces
 * (namespace { ... }) also give internal linkage.
 */
export const cCppExportChecker: ExportChecker = (node, _name) => {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === 'function_definition' || cur.type === 'declaration') {
      // Check for 'static' storage class specifier as a direct child node.
      // This avoids reading the full function text (which can be very large).
      for (let i = 0; i < cur.childCount; i++) {
        const child = cur.child(i);
        if (child?.type === 'storage_class_specifier' && child.text === 'static') return false;
      }
    }
    // C++ anonymous namespace: namespace_definition with no name child = internal linkage
    if (cur.type === 'namespace_definition') {
      const hasName = cur.childForFieldName?.('name');
      if (!hasName) return false;
    }
    cur = cur.parent;
  }
  return true; // Top-level C/C++ functions default to external linkage
};

/** PHP: check for visibility modifier or top-level scope. */
export const phpExportChecker: ExportChecker = (node, _name) => {
  let current: SyntaxNode | null = node;
  while (current) {
    if (
      current.type === 'class_declaration' ||
      current.type === 'interface_declaration' ||
      current.type === 'trait_declaration' ||
      current.type === 'enum_declaration'
    ) {
      return true;
    }
    if (current.type === 'visibility_modifier') {
      return current.text === 'public';
    }
    current = current.parent;
  }
  // Top-level functions are globally accessible
  return true;
};

/**
 * Swift: treat symbols as exported unless explicitly marked private/fileprivate.
 *
 * Swift's default access level is `internal`, which means visible to all files
 * in the same module/target. Since GitNexus indexes at the target level,
 * `internal` symbols should be treated as exported (cross-file visible).
 * Only `private` and `fileprivate` symbols are truly file-scoped.
 */
export const swiftExportChecker: ExportChecker = (node, _name) => {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === 'modifiers' || current.type === 'visibility_modifier') {
      const text = current.text || '';
      // Exclude private(set)/fileprivate(set) — only the setter is restricted,
      // the symbol itself is still readable cross-file.
      if (/\b(private|fileprivate)\b(?!\s*\()/.test(text)) return false;
    }
    current = current.parent;
  }
  // Default (internal), public, and open are all cross-file visible
  return true;
};

/** Ruby: all top-level definitions are public (no export syntax). */
export const rubyExportChecker: ExportChecker = (_node, _name) => true;

/** Dart: public if no leading underscore (convention, same as Python). */
export const dartExportChecker: ExportChecker = (_node, name) => !name.startsWith('_');
