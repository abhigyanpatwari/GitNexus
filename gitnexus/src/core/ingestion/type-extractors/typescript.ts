import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'lexical_declaration',
  'variable_declaration',
]);

/** TypeScript: const x: Foo = ..., let x: Foo */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    if (declarator?.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const typeAnnotation = declarator.childForFieldName('type');
    if (!nameNode || !typeAnnotation) continue;
    const varName = extractVarName(nameNode);
    const typeName = extractSimpleTypeName(typeAnnotation);
    if (varName && typeName) env.set(varName, typeName);
  }
};

/** TypeScript: required_parameter / optional_parameter → name: type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    nameNode = node.childForFieldName('pattern') ?? node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  } else {
    // Generic fallback
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
};
