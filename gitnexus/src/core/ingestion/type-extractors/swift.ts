import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup } from './types.js';
import { extractSimpleTypeName, extractVarName, findChildByType } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'property_declaration',
]);

/** Swift: let x: Foo = ... */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  // Swift property_declaration has pattern and type_annotation
  const pattern = node.childForFieldName('pattern')
    ?? findChildByType(node, 'pattern');
  const typeAnnotation = node.childForFieldName('type')
    ?? findChildByType(node, 'type_annotation');
  if (!pattern || !typeAnnotation) return;
  const varName = extractVarName(pattern) ?? pattern.text;
  const typeName = extractSimpleTypeName(typeAnnotation);
  if (varName && typeName) env.set(varName, typeName);
};

/** Swift: parameter → name: type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('name')
      ?? node.childForFieldName('internal_name');
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

/** Swift: let user = User(name: "alice") — infer type from call when callee is a known class.
 *  Swift initializers are syntactically identical to function calls, so we verify
 *  against classNames (which may include cross-file SymbolTable lookups). */
const extractInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup): void => {
  if (node.type !== 'property_declaration') return;
  // Skip if has type annotation — extractDeclaration handled it
  if (node.childForFieldName('type') || findChildByType(node, 'type_annotation')) return;
  // Find pattern (variable name)
  const pattern = node.childForFieldName('pattern') ?? findChildByType(node, 'pattern');
  if (!pattern) return;
  const varName = extractVarName(pattern) ?? pattern.text;
  if (!varName || env.has(varName)) return;
  // Find call_expression in the value
  const callExpr = findChildByType(node, 'call_expression');
  if (!callExpr) return;
  const callee = callExpr.firstNamedChild;
  if (!callee) return;
  // Direct call: User(name: "alice")
  if (callee.type === 'simple_identifier') {
    const calleeName = callee.text;
    if (calleeName && classNames.has(calleeName)) {
      env.set(varName, calleeName);
    }
    return;
  }
  // Explicit init: User.init(name: "alice") — navigation_expression with .init suffix
  if (callee.type === 'navigation_expression') {
    const receiver = callee.firstNamedChild;
    const suffix = callee.lastNamedChild;
    if (receiver?.type === 'simple_identifier' && suffix?.text === 'init') {
      const calleeName = receiver.text;
      if (calleeName && classNames.has(calleeName)) {
        env.set(varName, calleeName);
      }
    }
  }
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
};
