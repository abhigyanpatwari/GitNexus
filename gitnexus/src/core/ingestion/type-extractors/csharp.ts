import type { SyntaxNode } from '../utils.js';
import type { ConstructorBindingScanner, LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName, findChildByType, unwrapAwait } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'local_declaration_statement',
  'variable_declaration',
  'field_declaration',
  'is_pattern_expression',
]);

/** C#: Type x = ...; var x = new Type(); obj is Type x */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  // C# pattern matching: `obj is User user` → is_pattern_expression > declaration_pattern
  if (node.type === 'is_pattern_expression') {
    const pattern = node.childForFieldName('pattern');
    if (pattern?.type === 'declaration_pattern') {
      const typeNode = pattern.childForFieldName('type');
      const nameNode = pattern.childForFieldName('name');
      if (typeNode && nameNode) {
        const typeName = extractSimpleTypeName(typeNode);
        const varName = extractVarName(nameNode);
        if (typeName && varName) env.set(varName, typeName);
      }
    }
    return;
  }

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
    // tree-sitter-c-sharp may put object_creation_expression as direct child
    // or inside equals_value_clause depending on grammar version
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

/** C#: var x = SomeFactory(...) → bind x to SomeFactory (constructor-like call) */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'variable_declaration') return undefined;
  // Find type and declarator children by iterating (C# grammar doesn't expose 'type' as a named field)
  let typeNode: SyntaxNode | null = null;
  let declarator: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'variable_declarator') { if (!declarator) declarator = child; }
    else if (!typeNode) { typeNode = child; }
  }
  // Only handle implicit_type (var) — explicit types handled by extractDeclaration
  if (!typeNode || typeNode.type !== 'implicit_type') return undefined;
  if (!declarator) return undefined;
  const nameNode = declarator.childForFieldName('name') ?? declarator.firstNamedChild;
  if (!nameNode || nameNode.type !== 'identifier') return undefined;
  // Find the initializer value: either inside equals_value_clause or as a direct child
  // (tree-sitter-c-sharp puts invocation_expression directly inside variable_declarator)
  let value: SyntaxNode | null = null;
  for (let i = 0; i < declarator.namedChildCount; i++) {
    const child = declarator.namedChild(i);
    if (!child) continue;
    if (child.type === 'equals_value_clause') { value = child.firstNamedChild; break; }
    if (child.type === 'invocation_expression' || child.type === 'object_creation_expression' || child.type === 'await_expression') { value = child; break; }
  }
  if (!value) return undefined;
  // Unwrap await: `var user = await svc.GetUserAsync()` → await_expression wraps invocation_expression
  value = unwrapAwait(value);
  if (!value) return undefined;
  // Skip object_creation_expression (new User()) — handled by extractInitializer
  if (value.type === 'object_creation_expression') return undefined;
  if (value.type !== 'invocation_expression') return undefined;
  const func = value.firstNamedChild;
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  scanConstructorBinding,
};
