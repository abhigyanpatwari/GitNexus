import { SupportedLanguages } from 'gitnexus-shared';
import type { MethodExtractionConfig, ParameterInfo } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Zig method extraction.
 *
 * tree-sitter-zig containers (struct/enum/union) are anonymous; the binding
 * name lives on the parent variable_declaration. Methods inside a container
 * appear as plain `function_declaration` children of the container node.
 *
 * The first parameter is the receiver iff it is named `self` (convention) —
 * unlike Rust, Zig has no dedicated `self_parameter` node type.
 */

const extractZigOwnerName = (node: SyntaxNode): string | undefined => {
  const parent = node.parent;
  if (!parent || parent.type !== 'variable_declaration') return undefined;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child?.type === 'identifier') return child.text;
  }
  return undefined;
};

const extractZigName = (node: SyntaxNode): string | undefined => {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
};

const extractZigReturnType = (node: SyntaxNode): string | undefined => {
  // tree-sitter-zig labels the return type as the `type` field on
  // function_declaration (the same field name used for parameter types).
  const typeNode = node.childForFieldName('type');
  return typeNode?.text?.trim();
};

const extractZigParameters = (node: SyntaxNode): ParameterInfo[] => {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param || param.type !== 'parameter') continue;
    const nameNode = param.childForFieldName('name');
    const typeNode = param.childForFieldName('type');
    params.push({
      name: nameNode?.text ?? '?',
      type: typeNode?.text?.trim() ?? null,
      rawType: typeNode?.text?.trim() ?? null,
      isOptional: false,
      isVariadic: false,
    });
  }
  return params;
};

const hasPubKeyword = (node: SyntaxNode): boolean => {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'pub') return true;
  }
  return false;
};

const extractZigReceiverType = (node: SyntaxNode): string | undefined => {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return undefined;
  const first = paramList.namedChild(0);
  if (!first || first.type !== 'parameter') return undefined;
  const nameNode = first.childForFieldName('name');
  if (nameNode?.text !== 'self') return undefined;
  const typeNode = first.childForFieldName('type');
  return typeNode?.text?.trim();
};

export const zigMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Zig,
  typeDeclarationNodes: ['struct_declaration', 'enum_declaration', 'union_declaration'],
  methodNodeTypes: ['function_declaration'],
  bodyNodeTypes: [],
  extractOwnerName: extractZigOwnerName,
  extractName: extractZigName,
  extractReturnType: extractZigReturnType,
  extractParameters: extractZigParameters,
  extractVisibility: (node) => (hasPubKeyword(node) ? 'public' : 'private'),
  extractReceiverType: extractZigReceiverType,

  isStatic(node) {
    // A Zig "method" is effectively static if its first parameter is not `self`.
    const paramList = node.childForFieldName('parameters');
    if (!paramList) return true;
    const first = paramList.namedChild(0);
    if (!first || first.type !== 'parameter') return true;
    const nameNode = first.childForFieldName('name');
    return nameNode?.text !== 'self';
  },

  isAbstract() {
    return false;
  },

  isFinal() {
    return false;
  },
};
