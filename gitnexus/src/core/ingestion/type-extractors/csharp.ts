import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName, findChildByType } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'local_declaration_statement',
  'variable_declaration',
  'field_declaration',
]);

/** C#: Type x = ...; var x = new Type(); */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  // C# tree-sitter: local_declaration_statement > variable_declaration > ...
  // Recursively descend through wrapper nodes
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'variable_declaration' || child.type === 'local_declaration_statement') {
      extractDeclaration(child, env);
      return;
    }
  }

  // At variable_declaration level: first child is type, rest are variable_declarators
  let typeNode: SyntaxNode | null = null;
  const declarators: SyntaxNode[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (!typeNode && child.type !== 'variable_declarator' && child.type !== 'equals_value_clause') {
      // First non-declarator child is the type (identifier, implicit_type, generic_name, etc.)
      typeNode = child;
    }
    if (child.type === 'variable_declarator') {
      declarators.push(child);
    }
  }

  if (!typeNode || declarators.length === 0) return;

  // Handle 'var x = new Foo()' — infer from object_creation_expression
  let typeName: string | undefined;
  if (typeNode.type === 'implicit_type' && typeNode.text === 'var') {
    // Try to infer from initializer: var x = new Foo()
    // C# tree-sitter puts object_creation_expression as direct child of variable_declarator
    if (declarators.length === 1) {
      const initializer = findChildByType(declarators[0], 'object_creation_expression')
        ?? findChildByType(declarators[0], 'equals_value_clause')?.firstNamedChild;
      if (initializer?.type === 'object_creation_expression') {
        const ctorType = initializer.childForFieldName('type');
        if (ctorType) typeName = extractSimpleTypeName(ctorType);
      }
    }
  } else {
    typeName = extractSimpleTypeName(typeNode);
  }

  if (!typeName) return;
  for (const decl of declarators) {
    const nameNode = decl.childForFieldName('name') ?? decl.firstNamedChild;
    if (nameNode) {
      const varName = extractVarName(nameNode);
      if (varName) env.set(varName, typeName);
    }
  }
};

/** C#: parameter → type name */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    typeNode = node.childForFieldName('type');
    nameNode = node.childForFieldName('name');
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
