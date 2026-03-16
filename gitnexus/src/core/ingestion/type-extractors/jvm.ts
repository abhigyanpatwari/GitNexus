import type { SyntaxNode } from '../utils.js';
import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup, ConstructorBindingScanner, ForLoopExtractor, PendingAssignmentExtractor } from './types.js';
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
  const declarator = findChildByType(node, 'variable_declarator');
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

const JAVA_FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'enhanced_for_statement',
]);

/** Java: for (User user : users) — extract loop variable binding */
const extractJavaForLoopBinding: ForLoopExtractor = (node: SyntaxNode, scopeEnv: Map<string, string>): void => {
  const typeNode = node.childForFieldName('type');
  const nameNode = node.childForFieldName('name');
  if (!typeNode || !nameNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  const varName = extractVarName(nameNode);
  if (typeName && varName) scopeEnv.set(varName, typeName);
};

/** Java: var alias = u → local_variable_declaration > variable_declarator with name/value */
const extractJavaPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    const valueNode = child.childForFieldName('value');
    if (!nameNode || !valueNode) continue;
    const lhs = nameNode.text;
    if (scopeEnv.has(lhs)) continue;
    if (valueNode.type === 'identifier' || valueNode.type === 'simple_identifier') return { lhs, rhs: valueNode.text };
  }
  return undefined;
};

export const javaTypeConfig: LanguageTypeConfig = {
  declarationNodeTypes: JAVA_DECLARATION_NODE_TYPES,
  extractDeclaration: extractJavaDeclaration,
  extractParameter: extractJavaParameter,
  extractInitializer: extractJavaInitializer,
  scanConstructorBinding: scanJavaConstructorBinding,
  forLoopNodeTypes: JAVA_FOR_LOOP_NODE_TYPES,
  extractForLoopBinding: extractJavaForLoopBinding,
  extractPendingAssignment: extractJavaPendingAssignment,
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
  const varDecl = findChildByType(node, 'variable_declaration');
  if (!varDecl) return undefined;
  if (findChildByType(varDecl, 'user_type')) return undefined;
  const callExpr = findChildByType(node, 'call_expression');
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
  const nameNode = findChildByType(varDecl, 'simple_identifier');
  if (!nameNode) return undefined;
  return { varName: nameNode.text, calleeName };
};

const KOTLIN_FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'for_statement',
]);

/** Kotlin: for (user: User in users) — extract loop variable binding when explicit type annotation exists */
const extractKotlinForLoopBinding: ForLoopExtractor = (node: SyntaxNode, scopeEnv: Map<string, string>): void => {
  // Kotlin loop variable: variable_declaration child with optional user_type annotation
  const varDecl = findChildByType(node, 'variable_declaration');
  if (!varDecl) return;
  // Only extract when there is an explicit type annotation (user_type node)
  const typeNode = findChildByType(varDecl, 'user_type');
  if (!typeNode) return;
  const nameNode = findChildByType(varDecl, 'simple_identifier');
  if (!nameNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  const varName = extractVarName(nameNode);
  if (typeName && varName) scopeEnv.set(varName, typeName);
};

/** Kotlin: val alias = u → property_declaration or variable_declaration.
 *  property_declaration has: binding_pattern_kind("val"), variable_declaration("alias"),
 *  "=", and the RHS value (simple_identifier "u").
 *  variable_declaration appears directly inside functions and has simple_identifier children. */
const extractKotlinPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type === 'property_declaration') {
    // Find the variable name from variable_declaration child
    const varDecl = findChildByType(node, 'variable_declaration');
    if (!varDecl) return undefined;
    const nameNode = varDecl.firstNamedChild;
    if (!nameNode || nameNode.type !== 'simple_identifier') return undefined;
    const lhs = nameNode.text;
    if (scopeEnv.has(lhs)) return undefined;
    // Find the RHS: a simple_identifier sibling after the "=" token
    let foundEq = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === '=') { foundEq = true; continue; }
      if (foundEq && child.type === 'simple_identifier') {
        return { lhs, rhs: child.text };
      }
    }
    return undefined;
  }

  if (node.type === 'variable_declaration') {
    // variable_declaration directly inside functions: simple_identifier children
    const nameNode = findChildByType(node, 'simple_identifier');
    if (!nameNode) return undefined;
    const lhs = nameNode.text;
    if (scopeEnv.has(lhs)) return undefined;
    // Look for RHS simple_identifier after "=" in the parent (property_declaration)
    // variable_declaration itself doesn't contain "=" — it's in the parent
    const parent = node.parent;
    if (!parent) return undefined;
    let foundEq = false;
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      if (!child) continue;
      if (child.type === '=') { foundEq = true; continue; }
      if (foundEq && child.type === 'simple_identifier') {
        return { lhs, rhs: child.text };
      }
    }
    return undefined;
  }

  return undefined;
};

export const kotlinTypeConfig: LanguageTypeConfig = {
  declarationNodeTypes: KOTLIN_DECLARATION_NODE_TYPES,
  forLoopNodeTypes: KOTLIN_FOR_LOOP_NODE_TYPES,
  extractDeclaration: extractKotlinDeclaration,
  extractParameter: extractKotlinParameter,
  extractInitializer: extractKotlinInitializer,
  scanConstructorBinding: scanKotlinConstructorBinding,
  extractForLoopBinding: extractKotlinForLoopBinding,
  extractPendingAssignment: extractKotlinPendingAssignment,
};
