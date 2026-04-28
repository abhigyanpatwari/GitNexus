// gitnexus/src/core/ingestion/method-extractors/configs/csharp.ts
// Verified against tree-sitter-c-sharp 0.23.1

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  MethodInfo,
  MethodExtractorContext,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import {
  findVisibility,
  hasModifier,
  hasKeyword,
  collectModifierTexts,
} from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// C# helpers
// ---------------------------------------------------------------------------

const CSHARP_VIS = new Set<MethodVisibility>(['public', 'private', 'protected', 'internal']);

/**
 * Walk the parameter_list of a method or constructor and return typed ParameterInfo
 * entries.
 *
 * In tree-sitter-c-sharp (verified against ^0.23.1), the `params` variadic keyword
 * is NOT wrapped inside a `parameter` node.  It appears as a bare unnamed `params`
 * token at the `parameter_list` level, followed by a type node and an identifier
 * node that are also direct children of `parameter_list` (not of a `parameter` node).
 *
 * All other parameters are normal `parameter` named children of `parameter_list`:
 *   - name comes from field 'name'
 *   - type comes from field 'type'
 *   - ref / out: modifier children inside the parameter node prefix the type string
 *   - isOptional: an '=' token appears among the children (indicates a default value)
 */
function extractCSharpParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  return extractParametersFromList(paramList);
}

/** Extract parameters from a parameter_list node directly. */
function extractParametersFromList(paramList: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  let i = 0;
  while (i < paramList.childCount) {
    const child = paramList.child(i);
    if (!child) {
      i++;
      continue;
    }

    // `params` variadic: bare unnamed `params` keyword followed by type + identifier
    // siblings at the parameter_list level (not wrapped in a `parameter` node).
    if (!child.isNamed && child.type === 'params') {
      let typeNode: SyntaxNode | null = null;
      let nameText: string | undefined;
      let j = i + 1;
      while (j < paramList.childCount) {
        const sibling = paramList.child(j);
        if (!sibling) {
          j++;
          continue;
        }
        if (sibling.isNamed && sibling.type !== 'parameter') {
          if (!typeNode) {
            typeNode = sibling;
          } else if (sibling.type === 'identifier') {
            nameText = sibling.text;
            i = j;
            break;
          }
        }
        j++;
      }
      if (nameText) {
        params.push({
          name: nameText,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          rawType: typeNode?.text?.trim() ?? null,
          isOptional: false,
          isVariadic: true,
        });
      }
      i++;
      continue;
    }

    // Regular named `parameter` node
    if (child.isNamed && child.type === 'parameter') {
      const nameNode = child.childForFieldName('name');
      if (nameNode && nameNode.text.trim()) {
        const typeNode = child.childForFieldName('type');
        let typeName: string | null = typeNode
          ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
          : null;

        // Detect ref / out modifiers inside the parameter node — prefix the type string
        for (let j = 0; j < child.namedChildCount; j++) {
          const c = child.namedChild(j);
          if (!c || c.type !== 'modifier') continue;
          const modText = c.text.trim();
          if (modText === 'out' || modText === 'ref' || modText === 'in' || modText === 'this') {
            typeName = typeName ? `${modText} ${typeName}` : modText;
            break;
          }
        }

        // Detect optional (default value) — an '=' token among direct children
        let isOptional = false;
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c && c.text.trim() === '=') {
            isOptional = true;
            break;
          }
        }

        params.push({
          name: nameNode.text,
          type: typeName,
          rawType: typeNode?.text?.trim() ?? null,
          isOptional,
          isVariadic: false,
        });
      }
    }

    i++;
  }

  return params;
}

/**
 * Collect C# attributes from attribute_list nodes on a method or constructor.
 * Skips attribute lists with a target specifier (e.g. [return: NotNull],
 * [param: Required]) — those target a different declaration element.
 * Names are prefixed with '@' to mirror the JVM convention.
 */
function extractCSharpAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'attribute_list') continue;
    // Skip targeted attribute lists (e.g. [return: ...], [method: ...])
    let hasTarget = false;
    for (let j = 0; j < child.namedChildCount; j++) {
      if (child.namedChild(j)?.type === 'attribute_target_specifier') {
        hasTarget = true;
        break;
      }
    }
    if (hasTarget) continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const attr = child.namedChild(j);
      if (!attr || attr.type !== 'attribute') continue;
      const nameNode = attr.childForFieldName('name');
      if (nameNode) annotations.push('@' + nameNode.text);
    }
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// C# config
// ---------------------------------------------------------------------------

export const csharpMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.CSharp,
  typeDeclarationNodes: [
    'class_declaration',
    'struct_declaration',
    'interface_declaration',
    'record_declaration',
  ],
  methodNodeTypes: [
    'method_declaration',
    'constructor_declaration',
    'destructor_declaration',
    'operator_declaration',
    'conversion_operator_declaration',
    'local_function_statement',
  ],
  bodyNodeTypes: ['declaration_list'],

  extractName(node) {
    // destructor_declaration: prefix with ~ to distinguish from constructor
    if (node.type === 'destructor_declaration') {
      const name = node.childForFieldName('name')?.text;
      return name ? `~${name}` : undefined;
    }
    // operator_declaration: no 'name' field — use 'operator' field (e.g., +, ==)
    if (node.type === 'operator_declaration') {
      const op = node.childForFieldName('operator');
      return op ? `operator ${op.text.trim()}` : undefined;
    }
    // conversion_operator_declaration: no 'name' field — implicit/explicit + target type
    if (node.type === 'conversion_operator_declaration') {
      const typeNode = node.childForFieldName('type');
      const typeName = typeNode
        ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim())
        : undefined;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && !c.isNamed && (c.text === 'implicit' || c.text === 'explicit')) {
          return typeName ? `${c.text} operator ${typeName}` : undefined;
        }
      }
      return typeName ? `operator ${typeName}` : undefined;
    }
    return node.childForFieldName('name')?.text;
  },

  extractReturnType(node) {
    // Constructors and destructors have no return type
    // operator_declaration and conversion_operator_declaration use 'type' field, not 'returns'
    const returnsNode = node.childForFieldName('returns');
    if (returnsNode) return returnsNode.text?.trim();
    // Fallback for operator/conversion declarations that use 'type' as return type field
    if (node.type === 'operator_declaration' || node.type === 'conversion_operator_declaration') {
      const typeNode = node.childForFieldName('type');
      if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    }
    return undefined;
  },

  extractParameters: extractCSharpParameters,

  extractVisibility(node) {
    // Detect compound C# visibilities: protected internal, private protected
    const mods = collectModifierTexts(node);
    if (mods.has('protected') && mods.has('internal')) return 'protected internal';
    if (mods.has('private') && mods.has('protected')) return 'private protected';
    return findVisibility(node, CSHARP_VIS, 'private', 'modifier');
  },

  isStatic(node) {
    return hasKeyword(node, 'static') || hasModifier(node, 'modifier', 'static');
  },

  isAbstract(node, ownerNode) {
    if (hasKeyword(node, 'abstract') || hasModifier(node, 'modifier', 'abstract')) return true;
    // Interface methods are implicitly abstract when they have no body
    if (ownerNode.type === 'interface_declaration') {
      const body = node.childForFieldName('body');
      return !body;
    }
    return false;
  },

  isFinal(node) {
    // C# uses 'sealed' instead of 'final'
    return hasKeyword(node, 'sealed') || hasModifier(node, 'modifier', 'sealed');
  },

  extractAnnotations: extractCSharpAnnotations,

  isVirtual(node) {
    return hasKeyword(node, 'virtual') || hasModifier(node, 'modifier', 'virtual');
  },

  isOverride(node) {
    return hasKeyword(node, 'override') || hasModifier(node, 'modifier', 'override');
  },

  isAsync(node) {
    return hasKeyword(node, 'async') || hasModifier(node, 'modifier', 'async');
  },

  isPartial(node) {
    return hasKeyword(node, 'partial') || hasModifier(node, 'modifier', 'partial');
  },

  extractPrimaryConstructor(
    ownerNode: SyntaxNode,
    context: MethodExtractorContext,
  ): MethodInfo | null {
    // C# 12 primary constructors: class Point(int x, int y) { }
    // The parameter_list is a direct named child of class_declaration/record_declaration
    // but has NO field name — it must be found by iterating named children.
    let paramList: SyntaxNode | null = null;
    for (let i = 0; i < ownerNode.namedChildCount; i++) {
      const child = ownerNode.namedChild(i);
      if (child?.type === 'parameter_list') {
        paramList = child;
        break;
      }
    }
    if (!paramList) return null;

    const name = ownerNode.childForFieldName('name')?.text;
    if (!name) return null;

    const parameters = extractParametersFromList(paramList);

    return {
      name,
      receiverType: null,
      returnType: null,
      parameters,
      // Reuse the config's extractVisibility on the owner declaration node
      visibility: csharpMethodConfig.extractVisibility(ownerNode),
      isStatic: false,
      isAbstract: false,
      isFinal: false,
      annotations: [], // C# has no syntax for attributes on primary constructors
      sourceFile: context.filePath,
      line: paramList.startPosition.row + 1,
    };
  },
};
