import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup, ConstructorBindingScanner } from './types.js';
import { extractSimpleTypeName, extractVarName, findChildByType } from './shared.js';

// ── Java ──────────────────────────────────────────────────────────────────

const JAVA_DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'local_variable_declaration',
  'field_declaration',
]);

/** Java: Type x = ...; Type x; */
const extractJavaDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName || typeName === 'var') return; // skip Java 10 var — handled by extractInitializer

  // Find variable_declarator children
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    if (nameNode) {
      const varName = extractVarName(nameNode);
      if (varName) env.set(varName, typeName);
    }
  }
};

/** Java 10+: var x = new User() — infer type from object_creation_expression */
const extractJavaInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, _classNames: ClassNameLookup): void => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    const valueNode = child.childForFieldName('value');
    if (!nameNode || !valueNode) continue;
    // Skip declarators that already have a binding from extractDeclaration
    const varName = extractVarName(nameNode);
    if (!varName || env.has(varName)) continue;
    if (valueNode.type !== 'object_creation_expression') continue;
    const ctorType = valueNode.childForFieldName('type');
    if (!ctorType) continue;
    const typeName = extractSimpleTypeName(ctorType);
    if (typeName) env.set(varName, typeName);
  }
};

/** Java: formal_parameter → type name */
const extractJavaParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'formal_parameter') {
    typeNode = node.childForFieldName('type');
    nameNode = node.childForFieldName('name');
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

/** Java: var x = SomeFactory.create() — constructor binding for `var` with method_invocation */
const scanJavaConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'local_variable_declaration') return undefined;
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return undefined;
  if (typeNode.text !== 'var') return undefined;
  const declarator = node.namedChildren.find((c: SyntaxNode) => c.type === 'variable_declarator');
  if (!declarator) return undefined;
  const nameNode = declarator.childForFieldName('name');
  const value = declarator.childForFieldName('value');
  if (!nameNode || !value) return undefined;
  if (value.type === 'object_creation_expression') return undefined;
  if (value.type !== 'method_invocation') return undefined;
  const methodName = value.childForFieldName('name');
  if (!methodName) return undefined;
  return { varName: nameNode.text, calleeName: methodName.text };
};

export const javaTypeConfig: LanguageTypeConfig = {
  declarationNodeTypes: JAVA_DECLARATION_NODE_TYPES,
  extractDeclaration: extractJavaDeclaration,
  extractParameter: extractJavaParameter,
  extractInitializer: extractJavaInitializer,
  scanConstructorBinding: scanJavaConstructorBinding,
};

// ── Kotlin ────────────────────────────────────────────────────────────────

const KOTLIN_DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'property_declaration',
  'variable_declaration',
]);

/** Kotlin: val x: Foo = ... */
const extractKotlinDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type === 'property_declaration') {
    // Kotlin property_declaration: name/type are inside a variable_declaration child
    const varDecl = findChildByType(node, 'variable_declaration');
    if (varDecl) {
      const nameNode = findChildByType(varDecl, 'simple_identifier');
      const typeNode = findChildByType(varDecl, 'user_type');
      if (!nameNode || !typeNode) return;
      const varName = extractVarName(nameNode);
      const typeName = extractSimpleTypeName(typeNode);
      if (varName && typeName) env.set(varName, typeName);
      return;
    }
    // Fallback: try direct fields
    const nameNode = node.childForFieldName('name')
      ?? findChildByType(node, 'simple_identifier');
    const typeNode = node.childForFieldName('type')
      ?? findChildByType(node, 'user_type');
    if (!nameNode || !typeNode) return;
    const varName = extractVarName(nameNode);
    const typeName = extractSimpleTypeName(typeNode);
    if (varName && typeName) env.set(varName, typeName);
  } else if (node.type === 'variable_declaration') {
    // variable_declaration directly inside functions
    const nameNode = findChildByType(node, 'simple_identifier');
    const typeNode = findChildByType(node, 'user_type');
    if (nameNode && typeNode) {
      const varName = extractVarName(nameNode);
      const typeName = extractSimpleTypeName(typeNode);
      if (varName && typeName) env.set(varName, typeName);
    }
  }
};

/** Kotlin: formal_parameter → type name */
const extractKotlinParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'formal_parameter') {
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

/** Kotlin: val user = User() — infer type from call_expression when callee is a known class.
 *  Kotlin constructors are syntactically identical to function calls, so we verify
 *  against classNames (which may include cross-file SymbolTable lookups). */
const extractKotlinInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup): void => {
  if (node.type !== 'property_declaration') return;
  // Skip if there's an explicit type annotation — Tier 0 already handled it
  const varDecl = findChildByType(node, 'variable_declaration');
  if (varDecl && findChildByType(varDecl, 'user_type')) return;

  // Get the initializer value — the call_expression after '='
  const value = node.childForFieldName('value')
    ?? findChildByType(node, 'call_expression');
  if (!value || value.type !== 'call_expression') return;

  // The callee is the first child of call_expression (simple_identifier for direct calls)
  const callee = value.firstNamedChild;
  if (!callee || callee.type !== 'simple_identifier') return;

  const calleeName = callee.text;
  if (!calleeName || !classNames.has(calleeName)) return;

  // Extract the variable name from the variable_declaration inside property_declaration
  const nameNode = varDecl
    ? findChildByType(varDecl, 'simple_identifier')
    : findChildByType(node, 'simple_identifier');
  if (!nameNode) return;

  const varName = extractVarName(nameNode);
  if (varName) env.set(varName, calleeName);
};

/** Kotlin: val x = User(...) — constructor binding for property_declaration with call_expression */
const scanKotlinConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'property_declaration') return undefined;
  const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
  if (!varDecl) return undefined;
  if (varDecl.namedChildren.some(c => c.type === 'user_type')) return undefined;
  const callExpr = node.namedChildren.find(c => c.type === 'call_expression');
  if (!callExpr) return undefined;
  const callee = callExpr.firstNamedChild;
  if (!callee) return undefined;

  let calleeName: string | undefined;
  if (callee.type === 'simple_identifier') {
    calleeName = callee.text;
  } else if (callee.type === 'navigation_expression') {
    // Extract method name from qualified call: service.getUser() → getUser
    const suffix = callee.lastNamedChild;
    if (suffix?.type === 'navigation_suffix') {
      const methodName = suffix.lastNamedChild;
      if (methodName?.type === 'simple_identifier') {
        calleeName = methodName.text;
      }
    }
  }
  if (!calleeName) return undefined;
  const nameNode = varDecl.namedChildren.find(c => c.type === 'simple_identifier');
  if (!nameNode) return undefined;
  return { varName: nameNode.text, calleeName };
};

export const kotlinTypeConfig: LanguageTypeConfig = {
  declarationNodeTypes: KOTLIN_DECLARATION_NODE_TYPES,
  extractDeclaration: extractKotlinDeclaration,
  extractParameter: extractKotlinParameter,
  extractInitializer: extractKotlinInitializer,
  scanConstructorBinding: scanKotlinConstructorBinding,
};
