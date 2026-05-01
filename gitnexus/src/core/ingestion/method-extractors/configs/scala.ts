import { SupportedLanguages } from 'gitnexus-shared';
import type { MethodExtractionConfig, ParameterInfo } from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function extractScalaName(node: SyntaxNode): string | undefined {
  return node.childForFieldName('name')?.text;
}

function extractScalaReturnType(node: SyntaxNode): string | undefined {
  const retType = node.childForFieldName('return_type');
  if (retType) return extractSimpleTypeName(retType) ?? retType.text?.trim();
  return undefined;
}

function extractScalaParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== 'parameters') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const param = child.namedChild(j);
      if (param?.type !== 'parameter') continue;
      const nameNode = param.childForFieldName('name');
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode
        ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
        : null;
      params.push({
        name: nameNode?.text ?? `_${j}`,
        type: typeName,
        rawType: typeNode?.text?.trim() ?? null,
        isOptional: false,
        isVariadic: param.text?.includes('*') ?? false,
      });
    }
  }
  return params;
}

function extractScalaVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'modifiers') {
      if (child.text?.includes('private')) return 'private';
      if (child.text?.includes('protected')) return 'protected';
    }
  }
  return 'public';
}

export const scalaMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Scala,
  typeDeclarationNodes: [
    'class_definition',
    'object_definition',
    'trait_definition',
    'enum_definition',
  ],
  methodNodeTypes: ['function_definition', 'function_declaration'],
  bodyNodeTypes: ['template_body'],

  extractName: extractScalaName,
  extractReturnType: extractScalaReturnType,
  extractParameters: extractScalaParameters,
  extractVisibility: extractScalaVisibility,

  isStatic(_node) {
    return false;
  },

  isAbstract(node) {
    return node.type === 'function_declaration';
  },

  isFinal(node) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text?.includes('final')) return true;
    }
    return false;
  },
};
