import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup } from './types.js';
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

/** TypeScript: const x = new User() — infer type from new_expression */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, _classNames: ClassNameLookup): void => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    if (declarator?.type !== 'variable_declarator') continue;
    // Only activate when there is no explicit type annotation — extractDeclaration already
    // handles the annotated case and this function is called as a fallback.
    if (declarator.childForFieldName('type') !== null) continue;
    let valueNode = declarator.childForFieldName('value');
    // Unwrap `new User() as T`, `new User()!`, and double-cast `new User() as unknown as T`
    while (valueNode?.type === 'as_expression' || valueNode?.type === 'non_null_expression') {
      valueNode = valueNode.firstNamedChild;
    }
    if (valueNode?.type !== 'new_expression') continue;
    const constructorNode = valueNode.childForFieldName('constructor');
    if (!constructorNode) continue;
    const nameNode = declarator.childForFieldName('name');
    if (!nameNode) continue;
    const varName = extractVarName(nameNode);
    const typeName = extractSimpleTypeName(constructorNode);
    if (varName && typeName) env.set(varName, typeName);
  }
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
};
