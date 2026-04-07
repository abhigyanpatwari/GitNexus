// gitnexus/src/core/ingestion/method-extractors/configs/python.ts
// Verified against tree-sitter-python 0.23.4

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { hasKeyword } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Python helpers
// ---------------------------------------------------------------------------

/** Names that represent the instance/class receiver — not real parameters. */
const SELF_NAMES = new Set(['self', 'cls']);

/**
 * Unwrap a decorated_definition to its inner function_definition.
 *
 * tree-sitter-python wraps decorated functions/methods in a `decorated_definition`
 * node that contains the decorators as children followed by the function_definition.
 * This is different from TS/JS where decorators are siblings.
 */
function unwrapDecorated(node: SyntaxNode): SyntaxNode {
  if (node.type === 'decorated_definition') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'function_definition') return child;
    }
  }
  return node;
}

/**
 * Collect decorator names from a decorated_definition wrapper.
 *
 * Returns decorator names prefixed with '@'. If the node is a plain
 * function_definition (no decorators), check if its parent is a
 * decorated_definition and collect from there.
 */
function collectDecorators(node: SyntaxNode): SyntaxNode[] {
  let wrapper: SyntaxNode | null = null;
  if (node.type === 'decorated_definition') {
    wrapper = node;
  } else if (node.parent?.type === 'decorated_definition') {
    wrapper = node.parent;
  }
  if (!wrapper) return [];

  const decorators: SyntaxNode[] = [];
  for (let i = 0; i < wrapper.namedChildCount; i++) {
    const child = wrapper.namedChild(i);
    if (child && child.type === 'decorator') {
      decorators.push(child);
    }
  }
  return decorators;
}

function extractDecoratorName(decorator: SyntaxNode): string | undefined {
  // decorator > identifier (simple)
  // decorator > call > identifier (call-style, e.g. @lru_cache())
  // decorator > attribute (dotted, e.g. @abc.abstractmethod)
  const expr = decorator.firstNamedChild;
  if (!expr) return undefined;

  if (expr.type === 'identifier') return '@' + expr.text;
  if (expr.type === 'attribute') return '@' + expr.text;
  if (expr.type === 'call') {
    const fn = expr.childForFieldName('function');
    return fn ? '@' + fn.text : undefined;
  }
  return undefined;
}

function hasDecorator(node: SyntaxNode, name: string): boolean {
  const decorators = collectDecorators(node);
  for (const dec of decorators) {
    const decName = extractDecoratorName(dec);
    if (decName === '@' + name || decName?.endsWith('.' + name)) return true;
  }
  return false;
}

/**
 * Extract parameters from a Python function_definition.
 *
 * Handles: identifier, default_parameter, typed_parameter, typed_default_parameter,
 * list_splat_pattern (*args), dictionary_splat_pattern (**kwargs), and typed variants.
 * Skips `self` and `cls` first parameters.
 */
function extractPythonParameters(node: SyntaxNode): ParameterInfo[] {
  const funcNode = unwrapDecorated(node);
  const paramList = funcNode.childForFieldName('parameters');
  if (!paramList) return [];

  const params: ParameterInfo[] = [];
  let isFirst = true;

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'identifier': {
        // Bare parameter: `self`, `cls`, or untyped `x`
        if (isFirst && SELF_NAMES.has(param.text)) {
          isFirst = false;
          continue;
        }
        isFirst = false;
        params.push({
          name: param.text,
          type: null,
          rawType: null,
          isOptional: false,
          isVariadic: false,
        });
        break;
      }
      case 'default_parameter': {
        // `x = value` — untyped with default
        isFirst = false;
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({
            name: nameNode.text,
            type: null,
            rawType: null,
            isOptional: true,
            isVariadic: false,
          });
        }
        break;
      }
      case 'typed_parameter': {
        // `x: int` or `*args: str` or `**kwargs: int`
        // The first named child can be identifier, list_splat_pattern, or dictionary_splat_pattern
        const inner = param.firstNamedChild;
        if (!inner) break;

        if (isFirst && inner.type === 'identifier' && SELF_NAMES.has(inner.text)) {
          isFirst = false;
          continue;
        }
        isFirst = false;

        const typeNode = param.childForFieldName('type');
        const typeText = typeNode
          ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
          : null;

        const rawTypeText = typeNode?.text?.trim() ?? null;
        if (inner.type === 'list_splat_pattern') {
          const nameId = inner.firstNamedChild;
          if (nameId) {
            params.push({
              name: nameId.text,
              type: typeText,
              rawType: rawTypeText,
              isOptional: false,
              isVariadic: true,
            });
          }
        } else if (inner.type === 'dictionary_splat_pattern') {
          const nameId = inner.firstNamedChild;
          if (nameId) {
            params.push({
              name: nameId.text,
              type: typeText,
              rawType: rawTypeText,
              isOptional: false,
              isVariadic: true,
            });
          }
        } else {
          params.push({
            name: inner.text,
            type: typeText,
            rawType: rawTypeText,
            isOptional: false,
            isVariadic: false,
          });
        }
        break;
      }
      case 'typed_default_parameter': {
        // `x: int = 5` — typed with default
        isFirst = false;
        const nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (nameNode) {
          params.push({
            name: nameNode.text,
            type: typeNode
              ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
              : null,
            rawType: typeNode?.text?.trim() ?? null,
            isOptional: true,
            isVariadic: false,
          });
        }
        break;
      }
      case 'list_splat_pattern': {
        // `*args` (untyped)
        isFirst = false;
        const nameId = param.firstNamedChild;
        if (nameId) {
          params.push({
            name: nameId.text,
            type: null,
            rawType: null,
            isOptional: false,
            isVariadic: true,
          });
        }
        break;
      }
      case 'dictionary_splat_pattern': {
        // `**kwargs` (untyped)
        isFirst = false;
        const nameId = param.firstNamedChild;
        if (nameId) {
          params.push({
            name: nameId.text,
            type: null,
            rawType: null,
            isOptional: false,
            isVariadic: true,
          });
        }
        break;
      }
      default:
        isFirst = false;
        break;
    }
  }
  return params;
}

/**
 * Extract return type from the `return_type` field.
 *
 * tree-sitter-python uses a `type` field on function_definition for the return
 * type annotation (e.g. `-> str`). The field contains a type node.
 */
function extractPythonReturnType(node: SyntaxNode): string | undefined {
  const funcNode = unwrapDecorated(node);
  const returnType = funcNode.childForFieldName('return_type');
  if (!returnType) return undefined;
  // Use .text to preserve full generic types (e.g. list[User], Dict[str, User])
  // that the call resolver needs for for-loop iterable and return-type inference.
  return returnType.text?.trim();
}

/**
 * Extract visibility based on Python name-mangling convention.
 * `__name` (not dunder) = private, `_name` = protected, else public.
 */
function extractPythonVisibility(node: SyntaxNode): MethodVisibility {
  const funcNode = unwrapDecorated(node);
  const nameNode = funcNode.childForFieldName('name');
  const name = nameNode?.text;
  if (!name) return 'public';
  if (name.startsWith('__') && !name.endsWith('__')) return 'private';
  if (name.startsWith('_') && !(name.startsWith('__') && name.endsWith('__'))) return 'protected';
  return 'public';
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const pythonMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Python,
  typeDeclarationNodes: ['class_definition'],
  // Both function_definition and decorated_definition must be listed:
  // decorated methods appear as decorated_definition in the class body block,
  // while undecorated methods appear as function_definition directly.
  methodNodeTypes: ['function_definition', 'decorated_definition'],
  bodyNodeTypes: ['block'],

  extractName(node) {
    const funcNode = unwrapDecorated(node);
    const nameNode = funcNode.childForFieldName('name');
    return nameNode?.text;
  },

  extractReturnType: extractPythonReturnType,
  extractParameters: extractPythonParameters,
  extractVisibility: extractPythonVisibility,

  isStatic(node) {
    return hasDecorator(node, 'staticmethod') || hasDecorator(node, 'classmethod');
  },

  isAbstract(node, _ownerNode) {
    return hasDecorator(node, 'abstractmethod');
  },

  isFinal(_node) {
    return false; // @typing.final (PEP 591) is captured in annotations; isFinal not modeled
  },

  extractAnnotations(node) {
    const decorators = collectDecorators(node);
    const annotations: string[] = [];
    for (const dec of decorators) {
      const name = extractDecoratorName(dec);
      if (name) annotations.push(name);
    }
    return annotations;
  },

  isAsync(node) {
    const funcNode = unwrapDecorated(node);
    return hasKeyword(funcNode, 'async');
  },
};
