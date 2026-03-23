import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup, ConstructorBindingScanner } from './types.js';
import { extractSimpleTypeName, extractVarName, hasTypeAnnotation } from './shared.js';
import { findChild } from '../resolvers/utils.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'property_declaration',
]);

/** Swift: let x: Foo = ... */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  // Swift property_declaration has pattern and type_annotation
  const pattern = node.childForFieldName('pattern')
    ?? findChild(node, 'pattern');
  const typeAnnotation = node.childForFieldName('type')
    ?? findChild(node, 'type_annotation');
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
  if (node.childForFieldName('type') || findChild(node, 'type_annotation')) return;
  // Find pattern (variable name)
  const pattern = node.childForFieldName('pattern') ?? findChild(node, 'pattern');
  if (!pattern) return;
  const varName = extractVarName(pattern) ?? pattern.text;
  if (!varName || env.has(varName)) return;
  // Find call_expression in the value
  const callExpr = findChild(node, 'call_expression');
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

/** Swift: let user = User(name: "alice") — scan property_declaration for constructor binding */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'property_declaration') return undefined;
  if (hasTypeAnnotation(node)) return undefined;
  const pattern = node.childForFieldName('pattern');
  if (!pattern) return undefined;
  const varName = pattern.text;
  if (!varName) return undefined;
  let callExpr: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'call_expression') { callExpr = child; break; }
  }
  if (!callExpr) return undefined;
  const callee = callExpr.firstNamedChild;
  if (!callee) return undefined;
  if (callee.type === 'simple_identifier') {
    return { varName, calleeName: callee.text };
  }
  if (callee.type === 'navigation_expression') {
    const receiver = callee.firstNamedChild;
    const suffix = callee.lastNamedChild;
    if (receiver?.type === 'simple_identifier' && suffix?.text === 'init') {
      return { varName, calleeName: receiver.text };
    }
    // General qualified call: service.getUser() → extract method name.
    // tree-sitter-swift may wrap the identifier in navigation_suffix, so
    // check both direct simple_identifier and navigation_suffix > simple_identifier.
    if (suffix?.type === 'simple_identifier') {
      return { varName, calleeName: suffix.text };
    }
    if (suffix?.type === 'navigation_suffix') {
      const inner = suffix.lastNamedChild;
      if (inner?.type === 'simple_identifier') {
        return { varName, calleeName: inner.text };
      }
    }
  }
  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
};
