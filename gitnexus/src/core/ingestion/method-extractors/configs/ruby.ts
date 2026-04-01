// gitnexus/src/core/ingestion/method-extractors/configs/ruby.ts
// Verified against tree-sitter-ruby ^0.23.1

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Ruby helpers
// ---------------------------------------------------------------------------

const VISIBILITY_MODIFIERS = new Set(['private', 'protected', 'public']);

/**
 * Extract visibility for a Ruby method by walking backwards through the
 * parent body_statement's named children from the method node's position.
 *
 * Ruby visibility modifiers (private, protected, public) appear as bare
 * `identifier` nodes in the body_statement. The most recent modifier
 * before the method determines its visibility. Default is public.
 *
 * Example AST for:
 *   class Foo
 *     private
 *     def secret; end
 *   end
 *
 *   body_statement
 *     identifier "private"    ← index 0
 *     method "def secret"     ← index 1
 */
function extractRubyVisibility(node: SyntaxNode): MethodVisibility {
  const parent = node.parent;
  if (!parent) return 'public';

  // Find the index of this method node in the parent's named children
  let methodIndex = -1;
  for (let i = 0; i < parent.namedChildCount; i++) {
    if (parent.namedChild(i) === node) {
      methodIndex = i;
      break;
    }
  }
  if (methodIndex < 0) return 'public';

  // Walk backwards from the method node looking for a visibility modifier
  for (let i = methodIndex - 1; i >= 0; i--) {
    const sibling = parent.namedChild(i);
    if (!sibling) continue;
    if (sibling.type === 'identifier' && VISIBILITY_MODIFIERS.has(sibling.text)) {
      return sibling.text as MethodVisibility;
    }
  }
  return 'public';
}

/**
 * Extract parameters from a Ruby method's method_parameters node.
 *
 * Handles: identifier, optional_parameter (default), splat_parameter (*args),
 * hash_splat_parameter (**kwargs), block_parameter (&block), keyword_parameter.
 */
function extractRubyParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];

  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'identifier': {
        // Plain parameter: def foo(x)
        params.push({ name: param.text, type: null, isOptional: false, isVariadic: false });
        break;
      }
      case 'optional_parameter': {
        // Default parameter: def foo(x = 10)
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: true, isVariadic: false });
        }
        break;
      }
      case 'splat_parameter': {
        // Splat: def foo(*args)
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      case 'hash_splat_parameter': {
        // Double splat: def foo(**kwargs)
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      case 'block_parameter': {
        // Block: def foo(&block)
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: false, isVariadic: false });
        }
        break;
      }
      case 'keyword_parameter': {
        // Keyword: def foo(name:) or def foo(name: "default")
        const nameNode = param.childForFieldName('name');
        const valueNode = param.childForFieldName('value');
        if (nameNode) {
          params.push({
            name: nameNode.text,
            type: null,
            isOptional: !!valueNode,
            isVariadic: false,
          });
        }
        break;
      }
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const rubyMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Ruby,
  typeDeclarationNodes: ['class', 'module'],
  methodNodeTypes: ['method', 'singleton_method'],
  bodyNodeTypes: ['body_statement'],

  extractName(node) {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text;
  },

  extractReturnType(_node) {
    // Ruby has no type annotations — return type is always null
    return undefined;
  },

  extractParameters: extractRubyParameters,
  extractVisibility: extractRubyVisibility,

  isStatic(node) {
    return node.type === 'singleton_method';
  },

  isAbstract(_node) {
    return false; // Ruby has no abstract methods
  },

  isFinal(_node) {
    return false; // Ruby has no final methods
  },
};
