// gitnexus/src/core/ingestion/field-extractors/configs/perl.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractionConfig } from '../generic.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { FieldVisibility } from '../../field-types.js';

/**
 * Extract field names from Perl hash assignments and blessed objects.
 * Handles patterns like:
 *   $self->{field} = value;  # Hash field assignment
 *   my $self = { field => value };  # Hash initialization
 */
function extractPerlFieldNames(node: SyntaxNode): string[] {
  const names: string[] = [];

  // Handle hash element assignments: $obj->{field} = value
  if (node.type === 'assignment_expression') {
    const left = node.childForFieldName?.('left');
    if (left?.type === 'hash_element_expression') {
      const keyNode = left.childForFieldName?.('key');
      if (keyNode) {
        const fieldName = keyNode.text?.replace(/['"]/g, ''); // Remove quotes
        if (fieldName) {
          names.push(fieldName);
        }
      }
    }
  }

  // Handle hash initialization: { field => value }
  if (node.type === 'hash_ref') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'pair') {
        const key = child.childForFieldName?.('key');
        if (key) {
          const fieldName = key.text?.replace(/['"]/g, ''); // Remove quotes
          if (fieldName) {
            names.push(fieldName);
          }
        }
      }
    }
  }

  // Handle Moose/Moo has declarations: has 'field' => (...)
  if (node.type === 'function_call_expression') {
    const func = node.childForFieldName?.('function');
    if (func?.text === 'has') {
      const args = node.childForFieldName?.('arguments');
      if (args) {
        const firstArg = args.namedChild?.(0);
        if (firstArg && (firstArg.type === 'string_literal' || firstArg.type === 'quoted_word')) {
          const fieldName = firstArg.text?.replace(/['"]/g, '');
          if (fieldName) {
            names.push(fieldName);
          }
        }
      }
    }
  }

  return names;
}

export const perlConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Perl,

  // Type declaration nodes (packages, classes)
  typeDeclarationNodes: ['package_statement', 'class_statement'],

  // Field definition patterns: assignments, has declarations
  fieldNodeTypes: [
    'assignment_expression',
    'function_call_expression', // For Moose 'has' declarations
  ],

  // Body node types that contain fields
  bodyNodeTypes: ['block', 'body'],

  // Default visibility
  defaultVisibility: 'public',

  // Extract field name from declaration node
  extractName: (node: SyntaxNode): string | undefined => {
    // Hash element access: $obj->{field}
    if (node.type === 'hash_element_expression') {
      const key = node.childForFieldName?.('key');
      if (key) {
        return key.text?.replace(/['"]/g, '');
      }
    }

    // Method call access: $obj->field()
    if (node.type === 'method_call_expression') {
      const method = node.childForFieldName?.('method');
      if (method) {
        return method.text;
      }
    }

    // Moose has declarations
    if (node.type === 'function_call_expression') {
      const func = node.childForFieldName?.('function');
      if (func?.text === 'has') {
        const args = node.childForFieldName?.('arguments');
        if (args) {
          const firstArg = args.namedChild?.(0);
          if (firstArg && (firstArg.type === 'string_literal' || firstArg.type === 'quoted_word')) {
            return firstArg.text?.replace(/['"]/g, '');
          }
        }
      }
    }

    return undefined;
  },

  // Extract multiple field names from single declaration
  extractNames: extractPerlFieldNames,

  // Extract type annotation
  extractType: (node: SyntaxNode): string | undefined => {
    // Basic type inference for Perl
    if (node.type === 'assignment_expression') {
      const right = node.childForFieldName?.('right');
      if (right) {
        // Infer type from RHS
        switch (right.type) {
          case 'number':
            return 'Number';
          case 'string_literal':
            return 'String';
          case 'array_ref':
            return 'ArrayRef';
          case 'hash_ref':
            return 'HashRef';
        }
      }
    }
    return 'Scalar'; // Default Perl type
  },

  // Extract visibility
  extractVisibility: (node: SyntaxNode): FieldVisibility => {
    const name = node.childForFieldName?.('name')?.text || '';
    return name.startsWith('_') ? 'private' : 'public';
  },

  // Check if field is static (class-level)
  isStatic: (_node: SyntaxNode): boolean => {
    // Perl doesn't have explicit static fields
    return false;
  },

  // Check if field is readonly
  isReadonly: (_node: SyntaxNode): boolean => {
    // Perl doesn't have explicit readonly fields
    return false;
  },
};
