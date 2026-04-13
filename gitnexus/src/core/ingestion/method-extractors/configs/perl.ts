// gitnexus/src/core/ingestion/method-extractors/configs/perl.ts
// Basic Perl method extraction configuration

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Extract method visibility from Perl context.
 * Perl doesn't have explicit visibility modifiers like Java/C#, but uses conventions:
 * - Methods starting with _ are considered private by convention
 * - All others are public
 */
function extractPerlVisibility(node: SyntaxNode): MethodVisibility {
  // Try to get method name from the node
  const name = node.childForFieldName?.('name')?.text || '';
  return name.startsWith('_') ? 'private' : 'public';
}

/**
 * Extract parameter information from Perl subroutine/method signatures.
 * Handles both traditional and modern Perl parameter styles:
 * - Traditional: sub name { my ($param1, $param2) = @_; }
 * - Modern: sub name($param1, $param2) { }
 */
function extractPerlParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  // Modern Perl signatures: sub name($param1, $param2)
  const signature = node.childForFieldName?.('signature');
  if (signature) {
    for (let i = 0; i < signature.childCount; i++) {
      const child = signature.child(i);
      if (child?.type === 'signature_parameter') {
        const paramName = child.text?.replace(/^\$/, ''); // Remove $ sigil
        if (paramName) {
          params.push({
            name: paramName,
            type: 'Scalar', // Default type for Perl scalars
            isOptional: false,
            isVariadic: false,
          });
        }
      }
    }
    return params;
  }

  // Traditional Perl: look for my (...) = @_; pattern in method body
  const body = node.childForFieldName?.('body');
  if (body) {
    // Look for variable declaration with @_ assignment
    for (let i = 0; i < body.childCount; i++) {
      const stmt = body.child(i);
      if (stmt?.type === 'assignment_expression') {
        const right = stmt.childForFieldName?.('right');
        if (right?.text === '@_') {
          const left = stmt.childForFieldName?.('left');
          if (left?.type === 'array_ref') {
            // Extract parameter names from the array
            for (let j = 0; j < left.childCount; j++) {
              const param = left.child(j);
              if (param?.type === 'scalar') {
                const paramName = param.text?.replace(/^\$/, '');
                if (paramName) {
                  params.push({
                    name: paramName,
                    type: 'Scalar',
                    isOptional: false,
                    isVariadic: false,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return params;
}

/**
 * Extract return type from Perl POD documentation.
 * Looks for patterns like: =item Returns: ClassName or # Returns: Type
 */
function extractPerlReturnType(node: SyntaxNode): string | undefined {
  // Look for POD documentation above the subroutine
  let current = node.parent;
  while (current) {
    const prevSibling = current.previousSibling;
    if (prevSibling?.type === 'pod') {
      const podText = prevSibling.text;
      // Simple pattern matching for return type documentation
      const returnMatch = podText.match(/(?:Returns?|Return(?:ing)?):?\s*(\w+)/i);
      if (returnMatch) {
        return returnMatch[1];
      }
    }
    current = current.parent;
  }

  // Look for inline comments
  const body = node.childForFieldName?.('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child?.type === 'comment') {
        const commentText = child.text;
        const returnMatch = commentText.match(/(?:Returns?|Return(?:ing)?):?\s*(\w+)/i);
        if (returnMatch) {
          return returnMatch[1];
        }
      }
    }
  }

  return undefined;
}

export const perlMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Perl,

  // Type declaration containers (packages, classes)
  typeDeclarationNodes: ['package_statement', 'class_statement'],

  // Method node types in Perl
  methodNodeTypes: [
    'subroutine_declaration_statement',
    'method_declaration_statement', // Modern Perl
  ],

  // Body node types
  bodyNodeTypes: ['block', 'compound_statement'],

  extractName(node: SyntaxNode): string | undefined {
    const nameNode = node.childForFieldName?.('name');
    return nameNode?.text;
  },

  extractVisibility: extractPerlVisibility,
  extractParameters: extractPerlParameters,
  extractReturnType: extractPerlReturnType,

  isStatic(_node: SyntaxNode): boolean {
    // Perl doesn't have explicit static methods
    return false;
  },

  isAbstract(_node: SyntaxNode, _ownerNode: SyntaxNode): boolean {
    // Perl doesn't have abstract methods
    return false;
  },

  isFinal(_node: SyntaxNode): boolean {
    // Perl doesn't have final methods
    return false;
  },
};
