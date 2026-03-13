import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'declaration',
]);

/** C++: Type x = ...; Type* x; Type& x; */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName) return;

  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;

  // init_declarator: Type x = value
  const nameNode = declarator.type === 'init_declarator'
    ? declarator.childForFieldName('declarator')
    : declarator;
  if (!nameNode) return;

  // Handle pointer/reference declarators
  const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
    ? nameNode.firstNamedChild
    : nameNode;
  if (!finalName) return;

  const varName = extractVarName(finalName);
  if (varName) env.set(varName, typeName);
};

/** C/C++: parameter_declaration → type declarator */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter_declaration') {
    typeNode = node.childForFieldName('type');
    const declarator = node.childForFieldName('declarator');
    if (declarator) {
      nameNode = declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator'
        ? declarator.firstNamedChild
        : declarator;
    }
  } else {
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
