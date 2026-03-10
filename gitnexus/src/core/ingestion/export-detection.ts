/**
 * Export Detection
 *
 * Determines whether a symbol (function, class, etc.) is exported/public
 * in its language. This is a pure function — safe for use in worker threads.
 *
 * Shared between parse-worker.ts (worker pool) and parsing-processor.ts (sequential fallback).
 */

import { findSiblingChild } from './utils.js';

/** C# declaration node types for sibling modifier scanning. */
const CSHARP_DECL_TYPES = new Set([
  'method_declaration', 'local_function_statement', 'constructor_declaration',
  'class_declaration', 'interface_declaration', 'struct_declaration',
  'enum_declaration', 'record_declaration', 'record_struct_declaration',
  'record_class_declaration', 'delegate_declaration',
  'property_declaration', 'field_declaration', 'event_declaration',
  'namespace_declaration', 'file_scoped_namespace_declaration',
]);

/** Rust declaration node types for sibling visibility_modifier scanning. */
const RUST_DECL_TYPES = new Set([
  'function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item',
  'union_item', 'type_item', 'const_item', 'static_item', 'mod_item',
  'use_declaration', 'associated_type', 'function_signature_item',
]);

/**
 * Check if a tree-sitter node is exported/public in its language.
 * @param node - The tree-sitter AST node
 * @param name - The symbol name
 * @param language - The programming language
 * @returns true if the symbol is exported/public
 */
export const isNodeExported = (node: any, name: string, language: string): boolean => {
  let current = node;

  switch (language) {
    // JavaScript/TypeScript: Check for export keyword in ancestors
    case 'javascript':
    case 'typescript':
      while (current) {
        const type = current.type;
        if (type === 'export_statement' ||
            type === 'export_specifier' ||
            (type === 'lexical_declaration' && current.parent?.type === 'export_statement')) {
          return true;
        }
        // Fallback: check if node text starts with 'export ' for edge cases
        if (current.text?.startsWith('export ')) {
          return true;
        }
        current = current.parent;
      }
      return false;

    // Python: Public if no leading underscore (convention)
    case 'python':
      return !name.startsWith('_');

    // Java: Check for 'public' modifier
    // In tree-sitter Java, modifiers are siblings of the name node, not parents
    case 'java':
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

    // C#: modifier nodes are SIBLINGS of the name node inside the declaration.
    // Walk up to the declaration node, then scan its direct children.
    case 'csharp': {
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
    }

    // Go: Uppercase first letter = exported
    case 'go':
      if (name.length === 0) return false;
      const first = name[0];
      return first === first.toUpperCase() && first !== first.toLowerCase();

    // Rust: visibility_modifier is a SIBLING of the name node within the
    // declaration node (function_item, struct_item, etc.), not a parent.
    // Walk up to the declaration node, then scan its direct children.
    case 'rust': {
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
    }

    // Kotlin: Default visibility is public (unlike Java)
    // visibility_modifier is inside modifiers, a sibling of the name node within the declaration
    case 'kotlin':
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

    // C/C++: Functions without 'static' storage class have external linkage
    // by default, making them globally accessible (equivalent to exported).
    // Only functions explicitly marked 'static' are file-scoped (not exported).
    // C++ anonymous namespaces (namespace { ... }) also give internal linkage.
    case 'c':
    case 'cpp': {
      // Walk up to the function_definition/declaration and check for 'static'
      let cur = node;
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
    }

    // PHP: Check for visibility modifier or top-level scope
    case 'php':
      while (current) {
        if (current.type === 'class_declaration' ||
            current.type === 'interface_declaration' ||
            current.type === 'trait_declaration' ||
            current.type === 'enum_declaration') {
          return true;
        }
        if (current.type === 'visibility_modifier') {
          return current.text === 'public';
        }
        current = current.parent;
      }
      // Top-level functions are globally accessible
      return true;

    // Swift: Check for 'public' or 'open' access modifiers
    case 'swift':
      while (current) {
        if (current.type === 'modifiers' || current.type === 'visibility_modifier') {
          const text = current.text || '';
          if (text.includes('public') || text.includes('open')) return true;
        }
        current = current.parent;
      }
      return false;

    default:
      return false;
  }
};
