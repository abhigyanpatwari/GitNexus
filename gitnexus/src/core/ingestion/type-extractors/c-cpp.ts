import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'declaration',
  'for_range_loop',
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

/** C++: auto x = new User(); auto x = User(); */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup): void => {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;

  // Only handle auto/placeholder — typed declarations are handled by extractDeclaration
  const typeText = typeNode.text;
  if (
    typeText !== 'auto' &&
    typeText !== 'decltype(auto)' &&
    typeNode.type !== 'placeholder_type_specifier'
  ) return;

  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;

  // Must be an init_declarator (i.e., has an initializer value)
  if (declarator.type !== 'init_declarator') return;

  const value = declarator.childForFieldName('value');
  if (!value) return;

  // Resolve the variable name, unwrapping pointer/reference declarators
  const nameNode = declarator.childForFieldName('declarator');
  if (!nameNode) return;
  const finalName =
    nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
      ? nameNode.firstNamedChild
      : nameNode;
  if (!finalName) return;
  const varName = extractVarName(finalName);
  if (!varName) return;

  // auto x = new User() — new_expression
  if (value.type === 'new_expression') {
    const ctorType = value.childForFieldName('type');
    if (ctorType) {
      const typeName = extractSimpleTypeName(ctorType);
      if (typeName) env.set(varName, typeName);
    }
    return;
  }

  // auto x = User() — call_expression where function is a type name
  // tree-sitter-cpp may parse the constructor name as type_identifier or identifier.
  // For plain identifiers, verify against known class names from the file's AST
  // to distinguish constructor calls (User()) from function calls (getUser()).
  if (value.type === 'call_expression') {
    const func = value.childForFieldName('function');
    if (!func) return;
    if (func.type === 'type_identifier') {
      const typeName = func.text;
      if (typeName) env.set(varName, typeName);
    } else if (func.type === 'identifier') {
      const text = func.text;
      if (text && classNames.has(text)) env.set(varName, text);
    }
    return;
  }

  // auto x = User{} — compound_literal_expression (brace initialization)
  // AST: compound_literal_expression > type_identifier + initializer_list
  if (value.type === 'compound_literal_expression') {
    const typeId = value.firstNamedChild;
    const typeName = typeId ? extractSimpleTypeName(typeId) : undefined;
    if (typeName) env.set(varName, typeName);
  }
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
  extractInitializer,
};
