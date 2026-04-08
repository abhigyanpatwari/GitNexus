import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { hasModifier, hasKeyword } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { findChild } from '../../utils/ast-helpers.js';

const SCALA_VIS = new Set<MethodVisibility>(['public', 'private', 'protected', 'package']);

function extractScalaVisibility(node: SyntaxNode): MethodVisibility {
  const modifiers = node.childForFieldName('modifiers') ?? node.namedChildren[0] ?? null;
  const text = modifiers?.text ?? '';
  if (text.includes('private[') || text.includes('protected[')) return 'package';
  if (text.includes('private')) return 'private';
  if (text.includes('protected')) return 'protected';
  return 'public';
}

function extractScalaAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'annotation') {
      const nameNode = child.childForFieldName('name') ?? child.firstNamedChild;
      if (nameNode) annotations.push(`@${nameNode.text}`);
    }
  }
  return annotations;
}

function extractScalaParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'parameters') continue;
    const isImplicitParameterList = /\bimplicit\b/.test(child.text);
    for (let j = 0; j < child.namedChildCount; j++) {
      const param = child.namedChild(j);
      if (!param || (param.type !== 'parameter' && param.type !== 'class_parameter')) continue;
      const nameNode = param.childForFieldName('name');
      const typeNode = param.childForFieldName('type');
      if (!nameNode) continue;
      let hasDefault = false;
      for (let k = 0; k < param.childCount; k++) {
        if (param.child(k)?.text === '=') { hasDefault = true; break; }
      }
      params.push({
        name: nameNode.text,
        type: typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null) : null,
        isOptional: hasDefault || isImplicitParameterList,
        isVariadic: false,
      });
    }
  }
  return params;
}

function extractPrimaryConstructor(
  ownerNode: SyntaxNode,
  context: { filePath: string },
): {
  name: string;
  receiverType: null;
  returnType: null;
  parameters: ParameterInfo[];
  visibility: MethodVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  annotations: string[];
  sourceFile: string;
  line: number;
} | null {
  if (ownerNode.type !== 'class_definition') return null;
  const nameNode = ownerNode.childForFieldName('name');
  if (!nameNode) return null;

  const params: ParameterInfo[] = [];
  for (let i = 0; i < ownerNode.namedChildCount; i++) {
    const child = ownerNode.namedChild(i);
    if (!child || child.type !== 'class_parameters') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const pnode = child.namedChild(j);
      if (!pnode || pnode.type !== 'class_parameter') continue;
      const paramName = pnode.childForFieldName('name');
      const typeNode = pnode.childForFieldName('type');
      if (paramName) {
        params.push({
          name: paramName.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: pnode.text.includes('='),
          isVariadic: false,
        });
      }
    }
  }

  return {
    name: nameNode.text,
    receiverType: null,
    returnType: null,
    parameters: params,
    visibility: 'public',
    isStatic: false,
    isAbstract: false,
    isFinal: false,
    annotations: [],
    sourceFile: context.filePath,
    line: ownerNode.startPosition.row + 1,
  };
}

export const scalaMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Scala,
  typeDeclarationNodes: [
    'class_definition',
    'trait_definition',
    'object_definition',
    'enum_definition',
    'package_object',
  ],
  methodNodeTypes: ['function_definition', 'function_declaration'],
  bodyNodeTypes: ['template_body', 'enum_body'],

  extractName(node) {
    return node.childForFieldName('name')?.text ?? findChild(node, 'identifier')?.text;
  },

  extractReturnType(node) {
    const typeNode = node.childForFieldName('return_type');
    return typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : undefined;
  },

  extractParameters: extractScalaParameters,

  extractVisibility(node) {
    return extractScalaVisibility(node);
  },

  isStatic(_node) {
    return false;
  },

  isAbstract(node, ownerNode) {
    if (hasModifier(node, 'modifiers', 'abstract') || hasKeyword(node, 'abstract')) return true;
    return ownerNode.type === 'trait_definition' && node.type === 'function_declaration';
  },

  isFinal(node) {
    return hasModifier(node, 'modifiers', 'final') || hasKeyword(node, 'final');
  },

  extractAnnotations: extractScalaAnnotations,
  extractPrimaryConstructor,
};
