// gitnexus/src/core/ingestion/method-extractors/configs/solidity.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

function findVisibilityToken(node: SyntaxNode): MethodVisibility {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const text =
      child.type === 'visibility' ? child.text.trim() : !child.isNamed ? child.text.trim() : '';
    if (text === 'public' || text === 'external') return 'public';
    if (text === 'internal') return 'internal';
    if (text === 'private') return 'private';
  }
  // Default for Solidity functions without explicit visibility (pre-0.7) is public.
  return 'public';
}

function extractSolidityName(node: SyntaxNode): string | undefined {
  if (node.type === 'constructor_definition') return 'constructor';
  if (node.type === 'fallback_receive_definition') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      const text = child.text.trim();
      if (text === 'receive' || text === 'fallback') return text;
    }
    return 'fallback';
  }
  const nameNode =
    node.childForFieldName('function_name') ?? node.childForFieldName('name');
  return nameNode?.text;
}

function extractSolidityParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'parameter') continue;
    const name = child.childForFieldName('name')?.text ?? '<unnamed>';
    const typeNode = child.childForFieldName('type');
    const typeName = typeNode?.text?.trim() ?? null;
    params.push({
      name,
      type: typeName,
      rawType: typeName,
      isOptional: false,
      isVariadic: false,
    });
  }
  return params;
}

function extractSolidityReturnType(node: SyntaxNode): string | undefined {
  const ret = node.childForFieldName('return_type');
  return ret?.text?.trim();
}

export const solidityMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Solidity,
  typeDeclarationNodes: [
    'contract_declaration',
    'interface_declaration',
    'library_declaration',
  ],
  methodNodeTypes: [
    'function_definition',
    'modifier_definition',
    'constructor_definition',
    'fallback_receive_definition',
  ],
  bodyNodeTypes: ['contract_body'],

  extractName: extractSolidityName,
  extractReturnType: extractSolidityReturnType,
  extractParameters: extractSolidityParameters,
  extractVisibility: findVisibilityToken,

  isStatic: () => false,
  isAbstract: (node) => {
    // Interface functions and body-less definitions are abstract-ish.
    if (node.type === 'function_definition' && !node.childForFieldName('body')) return true;
    return false;
  },
  isFinal: () => false,
  isAsync: () => false,
  extractAnnotations: () => [],
};
