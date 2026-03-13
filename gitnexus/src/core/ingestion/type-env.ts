import type { SyntaxNode } from './utils.js';
import { FUNCTION_NODE_TYPES, extractFunctionName } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

/**
 * Per-file scoped type environment: maps (scope, variableName) → typeName.
 * Scope-aware: variables inside functions are keyed by function name,
 * file-level variables use the '' (empty string) scope.
 *
 * Design constraints:
 * - Explicit-only: only type annotations, never inferred types
 * - Scope-aware: function-local variables don't collide across functions
 * - Conservative: complex/generic types extract the base name only
 * - Per-file: built once, used for receiver resolution, then discarded
 */
export type TypeEnv = Map<string, Map<string, string>>;

/** File-level scope key */
const FILE_SCOPE = '';

/**
 * Look up a variable's type in the TypeEnv, trying the call's enclosing
 * function scope first, then falling back to file-level scope.
 */
export const lookupTypeEnv = (
  env: TypeEnv,
  varName: string,
  callNode: SyntaxNode,
): string | undefined => {
  // Determine the enclosing function scope for the call
  const scopeKey = findEnclosingScopeKey(callNode);

  // Try function-local scope first
  if (scopeKey) {
    const scopeEnv = env.get(scopeKey);
    if (scopeEnv) {
      const result = scopeEnv.get(varName);
      if (result) return result;
    }
  }

  // Fall back to file-level scope
  const fileEnv = env.get(FILE_SCOPE);
  return fileEnv?.get(varName);
};

/** Find the enclosing function name for scope lookup. */
const findEnclosingScopeKey = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName } = extractFunctionName(current);
      if (funcName) return `${funcName}@${current.startIndex}`;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Extract the simple type name from a type AST node.
 * Handles generic types (e.g., List<User> → List), qualified names
 * (e.g., models.User → User), and nullable types (e.g., User? → User).
 * Returns undefined for complex types (unions, intersections, function types).
 */
const extractSimpleTypeName = (typeNode: SyntaxNode): string | undefined => {
  // Direct type identifier
  if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier'
    || typeNode.type === 'simple_identifier') {
    return typeNode.text;
  }

  // Qualified/scoped names: take the last segment (e.g., models.User → User)
  if (typeNode.type === 'scoped_identifier' || typeNode.type === 'qualified_identifier'
    || typeNode.type === 'scoped_type_identifier' || typeNode.type === 'qualified_name'
    || typeNode.type === 'qualified_type'
    || typeNode.type === 'member_expression' || typeNode.type === 'attribute') {
    const last = typeNode.lastNamedChild;
    if (last && (last.type === 'type_identifier' || last.type === 'identifier'
      || last.type === 'simple_identifier' || last.type === 'name')) {
      return last.text;
    }
  }

  // Generic types: extract the base type (e.g., List<User> → List)
  if (typeNode.type === 'generic_type' || typeNode.type === 'parameterized_type') {
    const base = typeNode.childForFieldName('name')
      ?? typeNode.childForFieldName('type')
      ?? typeNode.firstNamedChild;
    if (base) return extractSimpleTypeName(base);
  }

  // Nullable types (Kotlin User?, C# User?)
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // Type annotations that wrap the actual type (TS/Python: `: Foo`, Kotlin: user_type)
  if (typeNode.type === 'type_annotation' || typeNode.type === 'type'
    || typeNode.type === 'user_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // Pointer/reference types (C++, Rust): User*, &User, &mut User
  if (typeNode.type === 'pointer_type' || typeNode.type === 'reference_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // PHP named_type / optional_type
  if (typeNode.type === 'named_type' || typeNode.type === 'optional_type') {
    const inner = typeNode.childForFieldName('name') ?? typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }

  // Name node (PHP)
  if (typeNode.type === 'name') {
    return typeNode.text;
  }

  return undefined;
};

/**
 * Extract variable name from a declarator or pattern node.
 * Returns the simple identifier text, or undefined for destructuring/complex patterns.
 */
const extractVarName = (node: SyntaxNode): string | undefined => {
  if (node.type === 'identifier' || node.type === 'simple_identifier'
    || node.type === 'variable_name' || node.type === 'name') {
    return node.text;
  }
  // variable_declarator (Java/C#): has a 'name' field
  if (node.type === 'variable_declarator') {
    const nameChild = node.childForFieldName('name');
    if (nameChild) return extractVarName(nameChild);
  }
  return undefined;
};

/** Node types for function/method parameters with type annotations */
const TYPED_PARAMETER_TYPES = new Set([
  'required_parameter',      // TS: (x: Foo)
  'optional_parameter',      // TS: (x?: Foo)
  'formal_parameter',        // Java/Kotlin
  'parameter',               // C#/Rust/Go/Python/Swift
  'parameter_declaration',   // C/C++ void f(Type name)
  'simple_parameter',        // PHP function(Foo $x)
]);

/**
 * Build a scoped TypeEnv from a tree-sitter AST for a given language.
 * Walks the tree tracking enclosing function scopes, so that variables
 * inside different functions don't collide.
 */
export const buildTypeEnv = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
): TypeEnv => {
  const env: TypeEnv = new Map();
  walkForTypes(tree.rootNode, language, env, FILE_SCOPE);
  return env;
};

const walkForTypes = (
  node: SyntaxNode,
  language: SupportedLanguages,
  env: TypeEnv,
  currentScope: string,
): void => {
  // Detect scope boundaries (function/method definitions)
  let scope = currentScope;
  if (FUNCTION_NODE_TYPES.has(node.type)) {
    const { funcName } = extractFunctionName(node);
    if (funcName) scope = `${funcName}@${node.startIndex}`;
  }

  // Get or create the sub-map for this scope
  if (!env.has(scope)) env.set(scope, new Map());
  const scopeEnv = env.get(scope)!;

  // Check if this node provides type information
  extractTypeBinding(node, language, scopeEnv);

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkForTypes(child, language, env, scope);
  }
};

/**
 * Try to extract a (variableName → typeName) binding from a single AST node.
 * Language-specific strategies for different declaration patterns.
 */
const extractTypeBinding = (
  node: SyntaxNode,
  language: SupportedLanguages,
  env: Map<string, string>,
): void => {
  // === PARAMETERS (most languages) ===
  if (TYPED_PARAMETER_TYPES.has(node.type)) {
    extractFromParameter(node, language, env);
    return;
  }

  // === TypeScript/JavaScript: lexical_declaration / variable_declaration ===
  if (language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript) {
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      extractFromTsDeclaration(node, env);
    }
    return;
  }

  // === Java: local_variable_declaration / field_declaration ===
  if (language === SupportedLanguages.Java) {
    if (node.type === 'local_variable_declaration' || node.type === 'field_declaration') {
      extractFromJavaDeclaration(node, env);
    }
    return;
  }

  // === C# ===
  if (language === SupportedLanguages.CSharp) {
    if (node.type === 'local_declaration_statement' || node.type === 'variable_declaration'
      || node.type === 'field_declaration') {
      extractFromCSharpDeclaration(node, env);
    }
    return;
  }

  // === Kotlin ===
  if (language === SupportedLanguages.Kotlin) {
    if (node.type === 'property_declaration') {
      extractFromKotlinDeclaration(node, env);
    }
    // Also handle variable_declaration directly (inside functions)
    if (node.type === 'variable_declaration') {
      const nameNode = findChildByType(node, 'simple_identifier');
      const typeNode = findChildByType(node, 'user_type');
      if (nameNode && typeNode) {
        const varName = extractVarName(nameNode);
        const typeName = extractSimpleTypeName(typeNode);
        if (varName && typeName) env.set(varName, typeName);
      }
    }
    return;
  }

  // === Rust ===
  if (language === SupportedLanguages.Rust) {
    if (node.type === 'let_declaration') {
      extractFromRustDeclaration(node, env);
    }
    return;
  }

  // === Go ===
  if (language === SupportedLanguages.Go) {
    if (node.type === 'var_declaration' || node.type === 'var_spec') {
      extractFromGoVarDeclaration(node, env);
    }
    if (node.type === 'short_var_declaration') {
      extractFromGoShortVarDeclaration(node, env);
    }
    return;
  }

  // === Python ===
  if (language === SupportedLanguages.Python) {
    if (node.type === 'assignment') {
      extractFromPythonAssignment(node, env);
    }
    return;
  }

  // === PHP ===
  if (language === SupportedLanguages.PHP) {
    // PHP has no local variable type annotations; params handled above
    return;
  }

  // === Swift ===
  if (language === SupportedLanguages.Swift) {
    if (node.type === 'property_declaration') {
      extractFromSwiftDeclaration(node, env);
    }
    return;
  }

  // === C++ ===
  if (language === SupportedLanguages.CPlusPlus || language === SupportedLanguages.C) {
    if (node.type === 'declaration') {
      extractFromCppDeclaration(node, env);
    }
    return;
  }
};

// ── Language-specific extractors ──────────────────────────────────────────

/** TypeScript: const x: Foo = ..., let x: Foo */
const extractFromTsDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
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

/** Java: Type x = ...; Type x; */
const extractFromJavaDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName) return;

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

/** C#: Type x = ...; var x = new Type(); */
const extractFromCSharpDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  // C# tree-sitter: local_declaration_statement > variable_declaration > ...
  // Recursively descend through wrapper nodes
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'variable_declaration' || child.type === 'local_declaration_statement') {
      extractFromCSharpDeclaration(child, env);
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

/** Kotlin: val x: Foo = ... */
const extractFromKotlinDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
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
};

/** Rust: let x: Foo = ... */
const extractFromRustDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  const pattern = node.childForFieldName('pattern');
  const typeNode = node.childForFieldName('type');
  if (!pattern || !typeNode) return;
  const varName = extractVarName(pattern);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Go: var x Foo */
const extractFromGoVarDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  // Go var_declaration contains var_spec children
  if (node.type === 'var_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const spec = node.namedChild(i);
      if (spec?.type === 'var_spec') extractFromGoVarDeclaration(spec, env);
    }
    return;
  }

  // var_spec: name type [= value]
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Go: x := Foo{...} — infer type from composite literal (handles multi-assignment) */
const extractFromGoShortVarDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;

  // Collect LHS names and RHS values (may be expression_lists for multi-assignment)
  const lhsNodes: SyntaxNode[] = [];
  const rhsNodes: SyntaxNode[] = [];

  if (left.type === 'expression_list') {
    for (let i = 0; i < left.namedChildCount; i++) {
      const c = left.namedChild(i);
      if (c) lhsNodes.push(c);
    }
  } else {
    lhsNodes.push(left);
  }

  if (right.type === 'expression_list') {
    for (let i = 0; i < right.namedChildCount; i++) {
      const c = right.namedChild(i);
      if (c) rhsNodes.push(c);
    }
  } else {
    rhsNodes.push(right);
  }

  // Pair each LHS name with its corresponding RHS value
  const count = Math.min(lhsNodes.length, rhsNodes.length);
  for (let i = 0; i < count; i++) {
    const valueNode = rhsNodes[i];
    if (valueNode.type !== 'composite_literal') continue;
    const typeNode = valueNode.childForFieldName('type');
    if (!typeNode) continue;
    const typeName = extractSimpleTypeName(typeNode);
    if (!typeName) continue;
    const varName = extractVarName(lhsNodes[i]);
    if (varName) env.set(varName, typeName);
  }
};

/** Python: x: Foo = ... (PEP 484 annotations) */
const extractFromPythonAssignment = (node: SyntaxNode, env: Map<string, string>): void => {
  // Python annotated assignment: left : type = value
  // tree-sitter represents this differently based on grammar version
  const left = node.childForFieldName('left');
  const typeNode = node.childForFieldName('type');
  if (!left || !typeNode) return;
  const varName = extractVarName(left);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Swift: let x: Foo = ... */
const extractFromSwiftDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
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

/** C++: Type x = ...; Type* x; Type& x; */
const extractFromCppDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
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

// ── Parameter extraction (shared across languages) ────────────────────────

/** Extract type binding from a function/method parameter node */
const extractFromParameter = (
  node: SyntaxNode,
  language: SupportedLanguages,
  env: Map<string, string>,
): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  // TypeScript: required_parameter / optional_parameter → name: type
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    nameNode = node.childForFieldName('pattern') ?? node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  }

  // Java: formal_parameter → type name
  else if (node.type === 'formal_parameter' && (language === SupportedLanguages.Java || language === SupportedLanguages.Kotlin)) {
    typeNode = node.childForFieldName('type');
    nameNode = node.childForFieldName('name');
  }

  // C#: parameter → type name
  else if (node.type === 'parameter' && language === SupportedLanguages.CSharp) {
    typeNode = node.childForFieldName('type');
    nameNode = node.childForFieldName('name');
  }

  // Rust: parameter → pattern: type
  else if (node.type === 'parameter' && language === SupportedLanguages.Rust) {
    nameNode = node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  // Go: parameter_declaration → name type
  else if (node.type === 'parameter' && language === SupportedLanguages.Go) {
    nameNode = node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  }

  // Python: typed_parameter or parameter with type
  else if (node.type === 'parameter' && language === SupportedLanguages.Python) {
    nameNode = node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  }

  // PHP: simple_parameter → type $name
  else if (node.type === 'simple_parameter' && language === SupportedLanguages.PHP) {
    typeNode = node.childForFieldName('type');
    nameNode = node.childForFieldName('name');
  }

  // Swift: parameter → name: type
  else if (node.type === 'parameter' && language === SupportedLanguages.Swift) {
    nameNode = node.childForFieldName('name')
      ?? node.childForFieldName('internal_name');
    typeNode = node.childForFieldName('type');
  }

  // C++: parameter_declaration → type declarator
  else if (node.type === 'parameter_declaration' && (language === SupportedLanguages.CPlusPlus || language === SupportedLanguages.C)) {
    typeNode = node.childForFieldName('type');
    const declarator = node.childForFieldName('declarator');
    if (declarator) {
      nameNode = declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator'
        ? declarator.firstNamedChild
        : declarator;
    }
  }

  // Generic fallback for other parameter types
  else {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

// ── Utility ───────────────────────────────────────────────────────────────

const findChildByType = (node: SyntaxNode, type: string): SyntaxNode | null => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
};
