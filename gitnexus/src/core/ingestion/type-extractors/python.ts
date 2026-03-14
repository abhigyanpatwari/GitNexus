import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup } from './types.js';
import { extractSimpleTypeName, extractVarName } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'assignment',
  'named_expression',
]);

/** Python: x: Foo = ... (PEP 484 annotations) */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  // Python annotated assignment: left : type = value
  // tree-sitter represents this differently based on grammar version
  const left = node.childForFieldName('left');
  const typeNode = node.childForFieldName('type');
  if (!left || !typeNode) return;
  const varName = extractVarName(left);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Python: parameter with type annotation */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  } else {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Python: user = User("alice") — infer type from call when callee is a known class.
 *  Python constructors are syntactically identical to function calls, so we verify
 *  against classNames (which may include cross-file SymbolTable lookups).
 *  Also handles walrus operator: if (user := User("alice")): */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup): void => {
  let left: SyntaxNode | null;
  let right: SyntaxNode | null;

  if (node.type === 'named_expression') {
    // Walrus operator: (user := User("alice"))
    // tree-sitter-python: named_expression has 'name' and 'value' fields
    left = node.childForFieldName('name');
    right = node.childForFieldName('value');
  } else if (node.type === 'assignment') {
    left = node.childForFieldName('left');
    right = node.childForFieldName('right');
    // Skip if already has type annotation — extractDeclaration handled it
    if (node.childForFieldName('type')) return;
  } else {
    return;
  }

  if (!left || !right) return;
  const varName = extractVarName(left);
  if (!varName || env.has(varName)) return;
  if (right.type !== 'call') return;
  const func = right.childForFieldName('function');
  if (!func) return;
  // Support both direct calls (User()) and qualified calls (models.User())
  // tree-sitter-python: direct → identifier, qualified → attribute
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return;
  if (classNames.has(calleeName)) {
    env.set(varName, calleeName);
  }
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
};
