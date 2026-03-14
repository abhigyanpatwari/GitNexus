import type { SyntaxNode } from '../utils.js';

/**
 * Extract the simple type name from a type AST node.
 * Handles generic types (e.g., List<User> → List), qualified names
 * (e.g., models.User → User), and nullable types (e.g., User? → User).
 * Returns undefined for complex types (unions, intersections, function types).
 */
export const extractSimpleTypeName = (typeNode: SyntaxNode): string | undefined => {
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

  // Nullable union types (TS/JS: User | null, User | undefined, User | null | undefined)
  // Extract the single non-null/undefined type from the union.
  if (typeNode.type === 'union_type') {
    const nonNullTypes: SyntaxNode[] = [];
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const child = typeNode.namedChild(i);
      if (!child) continue;
      // Skip null/undefined/void literal types
      const text = child.text;
      if (text === 'null' || text === 'undefined' || text === 'void') continue;
      nonNullTypes.push(child);
    }
    // Only unwrap if exactly one meaningful type remains
    if (nonNullTypes.length === 1) {
      return extractSimpleTypeName(nonNullTypes[0]);
    }
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

  // PHP primitive_type (string, int, float, bool)
  if (typeNode.type === 'primitive_type') {
    return typeNode.text;
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
export const extractVarName = (node: SyntaxNode): string | undefined => {
  if (node.type === 'identifier' || node.type === 'simple_identifier'
    || node.type === 'variable_name' || node.type === 'name') {
    return node.text;
  }
  // variable_declarator (Java/C#): has a 'name' field
  if (node.type === 'variable_declarator') {
    const nameChild = node.childForFieldName('name');
    if (nameChild) return extractVarName(nameChild);
  }
  // Rust: let mut x = ... — mut_pattern wraps an identifier
  if (node.type === 'mut_pattern') {
    const inner = node.firstNamedChild;
    if (inner) return extractVarName(inner);
  }
  return undefined;
};

/** Node types for function/method parameters with type annotations */
export const TYPED_PARAMETER_TYPES = new Set([
  'required_parameter',      // TS: (x: Foo)
  'optional_parameter',      // TS: (x?: Foo)
  'formal_parameter',        // Java/Kotlin
  'parameter',               // C#/Rust/Go/Python/Swift
  'parameter_declaration',   // C/C++ void f(Type name)
  'simple_parameter',        // PHP function(Foo $x)
  'property_promotion_parameter', // PHP 8.0+ constructor promotion: __construct(private Foo $x)
]);

/** Find the first named child with the given node type */
export const findChildByType = (node: SyntaxNode, type: string): SyntaxNode | null => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
};
