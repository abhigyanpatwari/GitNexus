import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
} from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';

/**
 * Perl type extractor — basic implementation.
 *
 * Perl is dynamically typed with optional type annotations via:
 * - POD documentation (@param, @returns)
 * - Modern Perl type systems (Moose, Type::Tiny, signatures)
 * - Constructor inference (bless patterns, new() methods)
 *
 * This implementation focuses on statically analyzable constructs:
 * - Variable declarations with sigils ($scalar, @array, %hash)
 * - Subroutine signatures (when available)
 * - Constructor patterns (Class->new(), bless)
 * - Package/class detection
 */

/** Extract variable name from Perl variables with sigils */
const extractPerlVarName = (node: SyntaxNode): string | null => {
  // Handle scalar_variable ($var), array_variable (@array), hash_variable (%hash)
  if (
    node.type === 'scalar_variable' ||
    node.type === 'array_variable' ||
    node.type === 'hash_variable'
  ) {
    const text = node.text;
    if (text.length > 1) {
      return text.slice(1); // Remove sigil ($, @, %)
    }
  }

  // Handle identifier nodes within variable contexts
  if (node.type === 'identifier') {
    return node.text;
  }

  return extractVarName(node);
};

/** Extract type bindings from Perl variable declarations */
const extractPerlDeclaration: TypeBindingExtractor = (node, env) => {
  // Handle variable_declaration from @ganezdragon grammar
  if (node.type === 'variable_declaration') {
    const varName = extractPerlVarName(node);
    if (varName) {
      // Basic type inference from context
      let typeName = 'Scalar'; // Default type

      // Check if it's an array or hash variable
      const firstChild = node.child(0);
      if (firstChild?.text?.startsWith('@')) {
        typeName = 'Array';
      } else if (firstChild?.text?.startsWith('%')) {
        typeName = 'Hash';
      }

      env.set(varName, typeName);
    }
  }

  // Handle binary_expression (assignment) from @ganezdragon grammar
  if (node.type === 'binary_expression') {
    const leftNode = node.childForFieldName?.('left');
    const rightNode = node.childForFieldName?.('right');

    if (leftNode && rightNode) {
      const varName = extractPerlVarName(leftNode);
      if (varName) {
        // Infer type from assignment RHS
        const typeName = inferTypeFromNode(rightNode);
        if (typeName) {
          env.set(varName, typeName);
        }
      }
    }
  }
};

/** Extract type bindings from Perl subroutine parameters */
const extractPerlParameter: ParameterExtractor = (node, env) => {
  // Modern Perl signatures: sub name($param1, $param2) { }
  if (node.type === 'signature_parameter') {
    const varName = extractPerlVarName(node);
    if (varName) {
      // Check for type annotations in signature
      const typeNode = node.childForFieldName?.('type');
      const typeName = typeNode ? extractSimpleTypeName(typeNode) : 'Scalar';
      env.set(varName, typeName || 'Scalar');
    }
  }

  // Traditional Perl: sub name { my ($param1, $param2) = @_; }
  if (node.type === 'variable_declaration' && node.parent?.type === 'function_definition') {
    const varName = extractPerlVarName(node);
    if (varName) {
      env.set(varName, 'Scalar');
    }
  }
};

/** Extract type bindings from Perl constructor calls */
const extractPerlInitializer: InitializerExtractor = (node, env, classNames) => {
  // Handle method_invocation patterns from @ganezdragon grammar
  if (node.type === 'method_invocation') {
    // Look for the object being called and the method name
    const objNode = node.child(0); // First child is typically the object
    const methodNode =
      node.childForFieldName?.('method') ||
      node.children.find((child) => child.type === 'identifier');

    if (objNode && methodNode?.text === 'new') {
      const className = objNode.text;
      if (classNames.has(className)) {
        // This is a constructor call - the containing assignment gets this type
        // The actual binding happens in extractDeclaration
        return;
      }
    }
  }

  // Handle bless function calls from @ganezdragon grammar
  if (node.type === 'function_call') {
    const functionNode =
      node.childForFieldName?.('function') ||
      node.children.find((child) => child.type === 'identifier');
    if (functionNode?.text === 'bless') {
      const args = node.children?.filter((child) => child.type === 'parenthesized_argument');
      if (args && args.length > 0) {
        // Second argument to bless is typically the class name
        const classArg = args[0].children?.[1];
        if (classArg && classArg.type === 'string_literal') {
          const className = classArg.text.replace(/['"]/g, '');
          if (classNames.has(className)) {
            // This is a bless constructor pattern
            return;
          }
        }
      }
    }
  }
};

/** Infer type from a node (for assignment RHS analysis) */
const inferTypeFromNode = (node: SyntaxNode): string | null => {
  switch (node.type) {
    case 'number':
      return 'Number';
    case 'string_single_quoted':
    case 'string_double_quoted':
    case 'interpolated_string_literal':
      return 'String';
    case 'array_ref':
    case 'array_deref_expression':
      return 'ArrayRef';
    case 'hash_ref':
    case 'hash_deref_expression':
      return 'HashRef';
    case 'method_invocation':
      // Check for constructor patterns
      const objNode = node.child(0);
      const methodNode = node.children.find((child) => child.type === 'identifier');
      if (methodNode?.text === 'new' && objNode) {
        return objNode.text; // Return class name
      }
      break;
    case 'function_call':
      const funcNode = node.children.find((child) => child.type === 'identifier');
      if (funcNode?.text === 'bless') {
        return 'Object'; // Generic blessed reference
      }
      break;
  }
  return null;
};

/** Perl type configuration */
export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: new Set([
    'variable_declaration',
    'binary_expression',
    'function_definition',
  ]),
  extractDeclaration: extractPerlDeclaration,
  extractParameter: extractPerlParameter,
  extractInitializer: extractPerlInitializer,
};
