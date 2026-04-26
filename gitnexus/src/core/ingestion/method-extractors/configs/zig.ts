// gitnexus/src/core/ingestion/method-extractors/configs/zig.ts
// Verified against @tree-sitter-grammars/tree-sitter-zig 1.1.2

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  MethodVisibility,
  ParameterInfo,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// Anonymous keyword children of a function_declaration node.
function hasKeywordChild(node: SyntaxNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.text === keyword) return true;
  }
  return false;
}

function extractZigMethodName(node: SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName?.('name');
  return nameNode?.text;
}

function extractZigReturnType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName?.('type');
  if (!typeNode) return undefined;
  return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
}

function extractZigParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName?.('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param || param.type !== 'parameter') continue;
    const nameNode = param.childForFieldName?.('name');
    const typeNode = param.childForFieldName?.('type');
    params.push({
      name: nameNode?.text ?? '?',
      type: typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null) : null,
      rawType: typeNode?.text?.trim() ?? null,
      isOptional: false,
      isVariadic: false,
    });
  }
  return params;
}

function extractZigVisibility(node: SyntaxNode): MethodVisibility {
  return hasKeywordChild(node, 'pub') ? 'public' : 'private';
}

/** A Zig "method" is detected as a function_declaration whose first
 *  parameter is named `self` — purely conventional, the language has no
 *  receiver syntax. We expose the convention via extractReceiverType so
 *  the call-resolution pipeline can route receiver.method() calls. */
function extractZigReceiverType(node: SyntaxNode): string | undefined {
  const paramList = node.childForFieldName?.('parameters');
  if (!paramList) return undefined;
  const first = paramList.namedChild(0);
  if (!first || first.type !== 'parameter') return undefined;
  const nameNode = first.childForFieldName?.('name');
  if (nameNode?.text !== 'self') return undefined;
  const typeNode = first.childForFieldName?.('type');
  return typeNode?.text?.trim();
}

/**
 * Owner resolution for a function_declaration nested inside a container.
 * The container is a struct_declaration / enum_declaration / union_declaration,
 * which is itself the value child of a variable_declaration. The owner name
 * is the bound identifier on that variable_declaration.
 */
function extractZigOwnerName(node: SyntaxNode): string | undefined {
  if (
    node.type !== 'struct_declaration' &&
    node.type !== 'enum_declaration' &&
    node.type !== 'union_declaration'
  ) {
    return undefined;
  }
  const parent = node.parent;
  if (parent?.type !== 'variable_declaration') return undefined;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const c = parent.namedChild(i);
    if (c?.type === 'identifier') return c.text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Zig config
// ---------------------------------------------------------------------------

export const zigMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Zig,
  // Methods live inside container declarations (struct/enum/union).
  typeDeclarationNodes: ['struct_declaration', 'enum_declaration', 'union_declaration'],
  methodNodeTypes: ['function_declaration'],
  // The container declaration itself is the body — function_declaration nodes
  // are direct named children.
  bodyNodeTypes: ['struct_declaration', 'enum_declaration', 'union_declaration'],

  extractOwnerName: extractZigOwnerName,
  extractName: extractZigMethodName,
  extractReturnType: extractZigReturnType,
  extractParameters: extractZigParameters,
  extractVisibility: extractZigVisibility,

  isStatic(node: SyntaxNode): boolean {
    // Static = no `self` first parameter.
    const paramList = node.childForFieldName?.('parameters');
    if (!paramList) return true;
    const first = paramList.namedChild(0);
    if (!first || first.type !== 'parameter') return true;
    const nameNode = first.childForFieldName?.('name');
    return nameNode?.text !== 'self';
  },

  isAbstract(_node: SyntaxNode, _ownerNode: SyntaxNode): boolean {
    // Zig has no abstract method concept.
    return false;
  },

  isFinal(): boolean {
    return false;
  },

  extractReceiverType: extractZigReceiverType,

  extractAnnotations(_node: SyntaxNode): string[] {
    return [];
  },
};
