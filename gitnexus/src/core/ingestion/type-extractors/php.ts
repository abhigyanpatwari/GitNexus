import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'assignment_expression', // For constructor inference: $x = new User()
  'property_declaration',  // PHP 7.4+ typed properties: private UserRepo $repo;
]);

/** Walk up the AST to find the enclosing class declaration. */
const findEnclosingClass = (node: SyntaxNode): SyntaxNode | null => {
  let current = node.parent;
  while (current) {
    if (current.type === 'class_declaration') return current;
    current = current.parent;
  }
  return null;
};

/**
 * Resolve PHP self/static/parent to the actual class name.
 * - self/static → enclosing class name
 * - parent → superclass from base_clause
 */
const resolvePhpKeyword = (keyword: string, node: SyntaxNode): string | undefined => {
  if (keyword === 'self' || keyword === 'static') {
    const cls = findEnclosingClass(node);
    if (!cls) return undefined;
    const nameNode = cls.childForFieldName('name');
    return nameNode?.text;
  }
  if (keyword === 'parent') {
    const cls = findEnclosingClass(node);
    if (!cls) return undefined;
    // base_clause contains the parent class name
    for (let i = 0; i < cls.namedChildCount; i++) {
      const child = cls.namedChild(i);
      if (child?.type === 'base_clause') {
        const parentName = child.firstNamedChild;
        if (parentName) return extractSimpleTypeName(parentName);
      }
    }
    return undefined;
  }
  return undefined;
};

/** PHP: typed class properties (PHP 7.4+): private UserRepo $repo; */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type !== 'property_declaration') return;

  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;

  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName) return;

  // The variable name is inside property_element > variable_name
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'property_element') {
      const varNameNode = child.firstNamedChild; // variable_name
      if (varNameNode) {
        const varName = extractVarName(varNameNode);
        if (varName) env.set(varName, typeName);
      }
      break;
    }
  }
};

/** PHP: $x = new User() — infer type from object_creation_expression */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, _classNames: ClassNameLookup): void => {
  if (node.type !== 'assignment_expression') return;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;
  if (right.type !== 'object_creation_expression') return;
  // The class name is the first named child of object_creation_expression
  // (tree-sitter-php uses 'name' or 'qualified_name' nodes here)
  const ctorType = right.firstNamedChild;
  if (!ctorType) return;
  const typeName = extractSimpleTypeName(ctorType);
  if (!typeName) return;
  // Resolve PHP self/static/parent to actual class names
  const resolvedType = (typeName === 'self' || typeName === 'static' || typeName === 'parent')
    ? resolvePhpKeyword(typeName, node)
    : typeName;
  if (!resolvedType) return;
  const varName = extractVarName(left);
  if (varName) env.set(varName, resolvedType);
};

/** PHP: simple_parameter → type $name */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'simple_parameter') {
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
  extractInitializer,
};
