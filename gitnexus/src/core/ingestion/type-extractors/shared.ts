import type { SyntaxNode } from '../utils.js';

/** Which type argument to extract from a multi-arg generic container.
 *  - 'first': key type (e.g., K from Map<K,V>) — used for .keys(), .keySet()
 *  - 'last':  value type (e.g., V from Map<K,V>) — used for .values(), .items(), .iter() */
export type TypeArgPosition = 'first' | 'last';

// ---------------------------------------------------------------------------
// Container type descriptors — maps container base names to type parameter
// semantics per access method. Replaces the simple KEY_METHODS heuristic.
//
// For user-defined generics (MyCache<K,V> extends Map<K,V>), heritage-aware
// fallback can walk the EXTENDS chain to find a matching descriptor.
// ---------------------------------------------------------------------------

/** Describes which type parameter position each access method yields. */
interface ContainerDescriptor {
  /** Number of type parameters (1 = single-element, 2 = key-value) */
  arity: number;
  /** Methods that yield the first type parameter (key type for maps) */
  keyMethods: ReadonlySet<string>;
  /** Methods that yield the last type parameter (value type) */
  valueMethods: ReadonlySet<string>;
}

/** Empty set for containers that have no key-yielding methods */
const NO_KEYS: ReadonlySet<string> = new Set();

/** Standard key-yielding methods across languages */
const STD_KEY_METHODS: ReadonlySet<string> = new Set(['keys']);
const JAVA_KEY_METHODS: ReadonlySet<string> = new Set(['keySet']);
const CSHARP_KEY_METHODS: ReadonlySet<string> = new Set(['Keys']);

/** Standard value-yielding methods across languages */
const STD_VALUE_METHODS: ReadonlySet<string> = new Set(['values', 'get', 'pop', 'remove']);
const CSHARP_VALUE_METHODS: ReadonlySet<string> = new Set(['Values', 'TryGetValue']);
const SINGLE_ELEMENT_METHODS: ReadonlySet<string> = new Set([
  'iter', 'into_iter', 'iterator', 'get', 'first', 'last', 'pop',
  'peek', 'poll', 'find', 'filter', 'map',
]);

const CONTAINER_DESCRIPTORS: ReadonlyMap<string, ContainerDescriptor> = new Map([
  // --- Map / Dict types (arity 2: key + value) ---
  ['Map',           { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['WeakMap',       { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['HashMap',       { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['BTreeMap',      { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['LinkedHashMap', { arity: 2, keyMethods: JAVA_KEY_METHODS,   valueMethods: STD_VALUE_METHODS }],
  ['TreeMap',       { arity: 2, keyMethods: JAVA_KEY_METHODS,   valueMethods: STD_VALUE_METHODS }],
  ['dict',          { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['Dict',          { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['Dictionary',    { arity: 2, keyMethods: CSHARP_KEY_METHODS, valueMethods: CSHARP_VALUE_METHODS }],
  ['SortedDictionary', { arity: 2, keyMethods: CSHARP_KEY_METHODS, valueMethods: CSHARP_VALUE_METHODS }],
  ['Record',        { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['OrderedDict',   { arity: 2, keyMethods: STD_KEY_METHODS,    valueMethods: STD_VALUE_METHODS }],
  ['ConcurrentHashMap', { arity: 2, keyMethods: JAVA_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['ConcurrentDictionary', { arity: 2, keyMethods: CSHARP_KEY_METHODS, valueMethods: CSHARP_VALUE_METHODS }],

  // --- Single-element containers (arity 1) ---
  ['Array',     { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['List',      { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ArrayList', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['LinkedList',{ arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Vec',       { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['VecDeque',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Set',       { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['HashSet',   { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['BTreeSet',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['TreeSet',   { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Queue',     { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Deque',     { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Stack',     { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Sequence',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Iterable',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Iterator',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['IEnumerable', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['IList',     { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ICollection', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Collection',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ObservableCollection', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['IEnumerator', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['SortedSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['Stream',    { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['MutableList', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['MutableSet',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['LinkedHashSet', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['ArrayDeque',  { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['PriorityQueue', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['MutableMap', { arity: 2, keyMethods: STD_KEY_METHODS, valueMethods: STD_VALUE_METHODS }],
  ['list',      { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['set',       { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['tuple',     { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
  ['frozenset', { arity: 1, keyMethods: NO_KEYS, valueMethods: SINGLE_ELEMENT_METHODS }],
]);

/** Determine which type arg to extract based on container type name and access method.
 *
 *  Resolution order:
 *  1. If container is known and method is in keyMethods → 'first'
 *  2. If container is known with arity 1 → 'last' (same as 'first' for single-arg)
 *  3. If container is unknown → fall back to method name heuristic
 *  4. Default: 'last' (value type)
 */
export function methodToTypeArgPosition(methodName: string | undefined, containerTypeName?: string): TypeArgPosition {
  if (containerTypeName) {
    const desc = CONTAINER_DESCRIPTORS.get(containerTypeName);
    if (desc) {
      // Single-element container: always 'last' (= only arg)
      if (desc.arity === 1) return 'last';
      // Multi-element: check if method yields key type
      if (methodName && desc.keyMethods.has(methodName)) return 'first';
      // Default for multi-element: value type
      return 'last';
    }
  }
  // Fallback for unknown containers: simple method name heuristic
  if (methodName && (methodName === 'keys' || methodName === 'keySet' || methodName === 'Keys')) {
    return 'first';
  }
  return 'last';
}

/** Look up the container descriptor for a type name. Exported for heritage-chain lookups. */
export function getContainerDescriptor(typeName: string): ContainerDescriptor | undefined {
  return CONTAINER_DESCRIPTORS.get(typeName);
}

/**
 * Shared 3-strategy fallback for resolving the element type of a container variable.
 * Used by all for-loop extractors to resolve the loop variable's type from the iterable.
 *
 * Strategy 1: declarationTypeNodes — raw AST type annotation node (handles container types
 *             where extractSimpleTypeName returned undefined, e.g., User[], List[User])
 * Strategy 2: scopeEnv string — extractElementTypeFromString on the stored type string
 * Strategy 3: AST walk — language-specific upward walk to enclosing function parameters
 *
 * @param extractFromTypeNode Language-specific function to extract element type from AST node
 * @param findParamElementType Optional language-specific AST walk to find parameter type
 * @param typeArgPos Which generic type arg to extract: 'first' for keys, 'last' for values (default)
 */
export function resolveIterableElementType(
  iterableName: string,
  node: SyntaxNode,
  scopeEnv: ReadonlyMap<string, string>,
  declarationTypeNodes: ReadonlyMap<string, SyntaxNode>,
  scope: string,
  extractFromTypeNode: (typeNode: SyntaxNode, pos?: TypeArgPosition) => string | undefined,
  findParamElementType?: (name: string, startNode: SyntaxNode, pos?: TypeArgPosition) => string | undefined,
  typeArgPos: TypeArgPosition = 'last',
): string | undefined {
  // Strategy 1: declarationTypeNodes AST node (check current scope, then file scope)
  const typeNode = declarationTypeNodes.get(`${scope}\0${iterableName}`)
    ?? (scope !== '' ? declarationTypeNodes.get(`\0${iterableName}`) : undefined);
  if (typeNode) {
    const t = extractFromTypeNode(typeNode, typeArgPos);
    if (t) return t;
  }
  // Strategy 2: scopeEnv string → extractElementTypeFromString
  const iterableType = scopeEnv.get(iterableName);
  if (iterableType) {
    const el = extractElementTypeFromString(iterableType, typeArgPos);
    if (el) return el;
  }
  // Strategy 3: AST walk to function parameters
  if (findParamElementType) return findParamElementType(iterableName, node, typeArgPos);
  return undefined;
}

/** Known single-arg nullable wrapper types that unwrap to their inner type
 *  for receiver resolution. Optional<User> → "User", Option<User> → "User".
 *  Only nullable wrappers — NOT containers (List, Vec) or async wrappers (Promise, Future).
 *  See WRAPPER_GENERICS below for the full set used in return-type inference. */
const NULLABLE_WRAPPER_TYPES = new Set([
  'Optional',    // Java
  'Option',      // Rust, Scala
  'Maybe',       // Haskell-style, Kotlin Arrow
]);

/**
 * Extract the simple type name from a type AST node.
 * Handles generic types (e.g., List<User> → List), qualified names
 * (e.g., models.User → User), and nullable types (e.g., User? → User).
 * Returns undefined for complex types (unions, intersections, function types).
 */
export const extractSimpleTypeName = (typeNode: SyntaxNode, depth = 0): string | undefined => {
  if (depth > 50 || typeNode.text.length > 2048) return undefined;
  // Direct type identifier (includes Ruby 'constant' for class names)
  if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier'
    || typeNode.type === 'simple_identifier' || typeNode.type === 'constant') {
    return typeNode.text;
  }

  // Qualified/scoped names: take the last segment (e.g., models.User → User, Models::User → User)
  if (typeNode.type === 'scoped_identifier' || typeNode.type === 'qualified_identifier'
    || typeNode.type === 'scoped_type_identifier' || typeNode.type === 'qualified_name'
    || typeNode.type === 'qualified_type'
    || typeNode.type === 'member_expression' || typeNode.type === 'member_access_expression'
    || typeNode.type === 'attribute'
    || typeNode.type === 'scope_resolution'
    || typeNode.type === 'selector_expression') {
    const last = typeNode.lastNamedChild;
    if (last && (last.type === 'type_identifier' || last.type === 'identifier'
      || last.type === 'simple_identifier' || last.type === 'name'
      || last.type === 'constant' || last.type === 'property_identifier'
      || last.type === 'field_identifier')) {
      return last.text;
    }
  }

  // C++ template_type (e.g., vector<User>, map<string, User>): extract base name
  if (typeNode.type === 'template_type') {
    const base = typeNode.childForFieldName('name') ?? typeNode.firstNamedChild;
    if (base) return extractSimpleTypeName(base, depth + 1);
  }

  // Generic types: extract the base type (e.g., List<User> → List)
  // For nullable wrappers (Optional<User>, Option<User>), unwrap to inner type.
  if (typeNode.type === 'generic_type' || typeNode.type === 'parameterized_type'
    || typeNode.type === 'generic_name') {
    const base = typeNode.childForFieldName('name')
      ?? typeNode.childForFieldName('type')
      ?? typeNode.firstNamedChild;
    if (!base) return undefined;
    const baseName = extractSimpleTypeName(base, depth + 1);
    // Unwrap known nullable wrappers: Optional<User> → User, Option<User> → User
    if (baseName && NULLABLE_WRAPPER_TYPES.has(baseName)) {
      const args = extractGenericTypeArgs(typeNode);
      if (args.length >= 1) return args[0];
    }
    return baseName;
  }

  // Nullable types (Kotlin User?, C# User?)
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner, depth + 1);
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
      return extractSimpleTypeName(nonNullTypes[0], depth + 1);
    }
  }

  // Type annotations that wrap the actual type (TS/Python: `: Foo`, Kotlin: user_type)
  if (typeNode.type === 'type_annotation' || typeNode.type === 'type'
    || typeNode.type === 'user_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner, depth + 1);
  }

  // Pointer/reference types (C++, Rust): User*, &User, &mut User
  if (typeNode.type === 'pointer_type' || typeNode.type === 'reference_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner, depth + 1);
  }

  // Primitive/predefined types: string, int, float, bool, number, unknown, any
  // PHP: primitive_type; TS/JS: predefined_type
  if (typeNode.type === 'primitive_type' || typeNode.type === 'predefined_type') {
    return typeNode.text;
  }

  // PHP named_type / optional_type
  if (typeNode.type === 'named_type' || typeNode.type === 'optional_type') {
    const inner = typeNode.childForFieldName('name') ?? typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner, depth + 1);
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
    || node.type === 'variable_name' || node.type === 'name'
    || node.type === 'constant' || node.type === 'property_identifier') {
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
  'typed_parameter',         // Python: def f(x: Foo) — distinct from 'parameter' in tree-sitter-python
  'parameter_declaration',   // C/C++ void f(Type name)
  'simple_parameter',        // PHP function(Foo $x)
  'property_promotion_parameter', // PHP 8.0+ constructor promotion: __construct(private Foo $x)
  'closure_parameter',       // Rust: |user: User| — typed closure parameters
]);

/**
 * Extract type arguments from a generic type node.
 * e.g., List<User, String> → ['User', 'String'], Vec<User> → ['User']
 *
 * Used by extractSimpleTypeName to unwrap nullable wrappers (Optional<User> → User).
 *
 * Handles language-specific AST structures:
 * - TS/Java/Rust/Go: generic_type > type_arguments > type nodes
 * - C#:              generic_type > type_argument_list > type nodes
 * - Kotlin:          generic_type > type_arguments > type_projection > type nodes
 *
 * Note: Go slices/maps use slice_type/map_type, not generic_type — those are
 * NOT handled here. Use language-specific extractors for Go container types.
 *
 * @param typeNode A generic_type or parameterized_type AST node (or any node —
 *   returns [] for non-generic types).
 * @returns Array of resolved type argument names. Unresolvable arguments are omitted.
 */
export const extractGenericTypeArgs = (typeNode: SyntaxNode, depth = 0): string[] => {
  if (depth > 50) return [];
  // Unwrap wrapper nodes that may sit above the generic_type
  if (typeNode.type === 'type_annotation' || typeNode.type === 'type'
    || typeNode.type === 'user_type' || typeNode.type === 'nullable_type'
    || typeNode.type === 'optional_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractGenericTypeArgs(inner, depth + 1);
    return [];
  }

  // Only process generic/parameterized type nodes (includes C#'s generic_name)
  if (typeNode.type !== 'generic_type' && typeNode.type !== 'parameterized_type'
    && typeNode.type !== 'generic_name') {
    return [];
  }

  // Find the type_arguments / type_argument_list child
  let argsNode: SyntaxNode | null = null;
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child && (child.type === 'type_arguments' || child.type === 'type_argument_list')) {
      argsNode = child;
      break;
    }
  }
  if (!argsNode) return [];

  const result: string[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    let argNode = argsNode.namedChild(i);
    if (!argNode) continue;

    // Kotlin: type_arguments > type_projection > user_type > type_identifier
    if (argNode.type === 'type_projection') {
      argNode = argNode.firstNamedChild;
      if (!argNode) continue;
    }

    const name = extractSimpleTypeName(argNode);
    if (name) result.push(name);
  }

  return result;
};

/**
 * Match Ruby constructor assignment: `user = User.new` or `service = Models::User.new`.
 * Returns { varName, calleeName } or undefined if the node is not a Ruby constructor assignment.
 * Handles both simple constants and scope_resolution (namespaced) receivers.
 */
export const extractRubyConstructorAssignment = (
  node: SyntaxNode,
): { varName: string; calleeName: string } | undefined => {
  if (node.type !== 'assignment') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'identifier' && left.type !== 'constant') return undefined;
  if (right.type !== 'call') return undefined;
  const method = right.childForFieldName('method');
  if (!method || method.text !== 'new') return undefined;
  const receiver = right.childForFieldName('receiver');
  if (!receiver) return undefined;
  let calleeName: string;
  if (receiver.type === 'constant') {
    calleeName = receiver.text;
  } else if (receiver.type === 'scope_resolution') {
    // Models::User → extract last segment "User"
    const last = receiver.lastNamedChild;
    if (!last || last.type !== 'constant') return undefined;
    calleeName = last.text;
  } else {
    return undefined;
  }
  return { varName: left.text, calleeName };
};

/**
 * Check if an AST node has an explicit type annotation.
 * Checks both named fields ('type') and child nodes ('type_annotation').
 * Used by constructor binding scanners to skip annotated declarations.
 */
export const hasTypeAnnotation = (node: SyntaxNode): boolean => {
  if (node.childForFieldName('type')) return true;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'type_annotation') return true;
  }
  return false;
};

/** Bare nullable keywords that should not produce a receiver binding. */
const NULLABLE_KEYWORDS = new Set(['null', 'undefined', 'void', 'None', 'nil']);

/**
 * Strip nullable wrappers from a type name string.
 * Used by both lookupInEnv (TypeEnv annotations) and extractReturnTypeName
 * (return-type text) to normalize types before receiver lookup.
 *
 *   "User | null"           → "User"
 *   "User | undefined"      → "User"
 *   "User | null | undefined" → "User"
 *   "User?"                 → "User"
 *   "User | Repo"           → undefined  (genuine union — refuse)
 *   "null"                  → undefined
 */
export const stripNullable = (typeName: string): string | undefined => {
  let text = typeName.trim();
  if (!text) return undefined;

  if (NULLABLE_KEYWORDS.has(text)) return undefined;

  // Strip nullable suffix: User? → User
  if (text.endsWith('?')) text = text.slice(0, -1).trim();

  // Strip union with null/undefined/None/nil/void
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim()).filter(p =>
      p !== '' && !NULLABLE_KEYWORDS.has(p)
    );
    if (parts.length === 1) return parts[0];
    return undefined; // genuine union or all-nullable — refuse
  }

  return text || undefined;
};

/**
 * Unwrap an await_expression to get the inner value.
 * Returns the node itself if not an await_expression, or null if input is null.
 */
export const unwrapAwait = (node: SyntaxNode | null): SyntaxNode | null => {
  if (!node) return null;
  return node.type === 'await_expression' ? node.firstNamedChild : node;
};

/**
 * Extract the callee name from a call_expression node.
 * Navigates to the 'function' field (or first named child) and extracts a simple type name.
 */
export const extractCalleeName = (callNode: SyntaxNode): string | undefined => {
  const func = callNode.childForFieldName('function') ?? callNode.firstNamedChild;
  if (!func) return undefined;
  return extractSimpleTypeName(func);
};

/** Find the first named child with the given node type */
export const findChildByType = (node: SyntaxNode, type: string): SyntaxNode | null => {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
};

// Internal helper: extract the first comma-separated argument from a string,
// respecting nested angle-bracket and square-bracket depth.
function extractFirstArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '<' || ch === '[') depth++;
    else if (ch === '>' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * Extract element type from a container type string.
 * Uses bracket-balanced parsing (no regex) for generic argument extraction.
 * Returns undefined for ambiguous or unparseable strings.
 *
 * Handles:
 * - Array<User>    → User  (generic angle brackets)
 * - User[]         → User  (array suffix)
 * - []User         → User  (Go slice prefix)
 * - List[User]     → User  (Python subscript)
 * - [User]         → User  (Swift array sugar)
 * - vector<User>   → User  (C++ container)
 * - Vec<User>      → User  (Rust container)
 *
 * For multi-argument generics (Map<K, V>), returns the first or last type arg
 * based on `pos` ('first' for keys, 'last' for values — default 'last').
 * Returns undefined when the extracted type is not a simple word.
 */
export function extractElementTypeFromString(typeStr: string, pos: TypeArgPosition = 'last'): string | undefined {
  if (!typeStr || typeStr.length === 0 || typeStr.length > 2048) return undefined;

  // 1. Array suffix: User[] → User
  if (typeStr.endsWith('[]')) {
    const base = typeStr.slice(0, -2).trim();
    return base && /^\w+$/.test(base) ? base : undefined;
  }

  // 2. Go slice prefix: []User → User
  if (typeStr.startsWith('[]')) {
    const element = typeStr.slice(2).trim();
    return element && /^\w+$/.test(element) ? element : undefined;
  }

  // 3. Swift array sugar: [User] → User
  //    Must start with '[', end with ']', and contain no angle brackets
  //    (to avoid confusing with List[User] handled below).
  if (typeStr.startsWith('[') && typeStr.endsWith(']') && !typeStr.includes('<')) {
    const element = typeStr.slice(1, -1).trim();
    return element && /^\w+$/.test(element) ? element : undefined;
  }

  // 4. Generic bracket-balanced extraction: Array<User> / List[User] / Vec<User>
  //    Find the first opening bracket (< or [) and pick the one that appears first.
  const openAngle = typeStr.indexOf('<');
  const openSquare = typeStr.indexOf('[');

  let openIdx = -1;
  let openChar = '';
  let closeChar = '';

  if (openAngle >= 0 && (openSquare < 0 || openAngle < openSquare)) {
    openIdx = openAngle;
    openChar = '<';
    closeChar = '>';
  } else if (openSquare >= 0) {
    openIdx = openSquare;
    openChar = '[';
    closeChar = ']';
  }

  if (openIdx < 0) return undefined;

  // Walk bracket-balanced from the character after the opening bracket to find
  // the matching close bracket, tracking depth for nested brackets.
  // All bracket types (<, >, [, ]) contribute to depth uniformly, but only the
  // selected closeChar can match at depth 0 (prevents cross-bracket miscounting).
  let depth = 0;
  const start = openIdx + 1;
  let lastCommaIdx = -1; // Track last top-level comma for 'last' position
  for (let i = start; i < typeStr.length; i++) {
    const ch = typeStr[i];
    if (ch === '<' || ch === '[') {
      depth++;
    } else if (ch === '>' || ch === ']') {
      if (depth === 0) {
        // At depth 0 — only match if it is our selected close bracket.
        if (ch !== closeChar) return undefined; // mismatched bracket = malformed
        if (pos === 'last' && lastCommaIdx >= 0) {
          // Return last arg (text after last comma)
          const lastArg = typeStr.slice(lastCommaIdx + 1, i).trim();
          return lastArg && /^\w+$/.test(lastArg) ? lastArg : undefined;
        }
        const inner = typeStr.slice(start, i).trim();
        const firstArg = extractFirstArg(inner);
        return firstArg && /^\w+$/.test(firstArg) ? firstArg : undefined;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      if (pos === 'first') {
        // Return first arg (text before first comma)
        const arg = typeStr.slice(start, i).trim();
        return arg && /^\w+$/.test(arg) ? arg : undefined;
      }
      lastCommaIdx = i;
    }
  }

  return undefined;
}

// ── Return type text helpers ─────────────────────────────────────────────
// extractReturnTypeName works on raw return-type text already stored in
// SymbolDefinition (e.g. "User", "Promise<User>", "User | null", "*User").
// Extracts the base user-defined type name.

/** Primitive / built-in types that should NOT produce a receiver binding. */
const PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'int', 'float', 'double', 'long',
  'short', 'byte', 'char', 'bool', 'str', 'i8', 'i16', 'i32', 'i64',
  'u8', 'u16', 'u32', 'u64', 'f32', 'f64', 'usize', 'isize',
  'undefined', 'null', 'None', 'nil',
]);

/**
 * Extract a simple type name from raw return-type text.
 * Handles common patterns:
 *   "User"                → "User"
 *   "Promise<User>"       → "User"   (unwrap wrapper generics)
 *   "Option<User>"        → "User"
 *   "Result<User, Error>" → "User"   (first type arg)
 *   "User | null"         → "User"   (strip nullable union)
 *   "User?"               → "User"   (strip nullable suffix)
 *   "*User"               → "User"   (Go pointer)
 *   "&User"               → "User"   (Rust reference)
 * Returns undefined for complex types or primitives.
 */
const WRAPPER_GENERICS = new Set([
  'Promise', 'Observable', 'Future', 'CompletableFuture', 'Task', 'ValueTask',  // async wrappers
  'Option', 'Some', 'Optional', 'Maybe',                                         // nullable wrappers
  'Result', 'Either',                                                             // result wrappers
  // Rust smart pointers (Deref to inner type)
  'Rc', 'Arc', 'Weak',                                                          // pointer types
  'MutexGuard', 'RwLockReadGuard', 'RwLockWriteGuard',                          // guard types
  'Ref', 'RefMut',                                                               // RefCell guards
  'Cow',                                                                         // copy-on-write
  // Containers (List, Array, Vec, Set, etc.) are intentionally excluded —
  // methods are called on the container, not the element type.
  // Non-wrapper generics return the base type (e.g., List) via the else branch.
]);

/**
 * Extracts the first type argument from a comma-separated generic argument string,
 * respecting nested angle brackets. For example:
 *   "Result<User, Error>"  → "Result<User, Error>"  (no top-level comma)
 *   "User, Error"          → "User"
 *   "Map<K, V>, string"    → "Map<K, V>"
 */
function extractFirstGenericArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '<') depth++;
    else if (args[i] === '>') depth--;
    else if (args[i] === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * Extract the first non-lifetime type argument from a generic argument string.
 * Skips Rust lifetime parameters (e.g., `'a`, `'_`) to find the actual type.
 *   "'_, User"       → "User"
 *   "'a, User"       → "User"
 *   "User, Error"    → "User"  (no lifetime — delegates to extractFirstGenericArg)
 */
function extractFirstTypeArg(args: string): string {
  let remaining = args;
  while (remaining) {
    const first = extractFirstGenericArg(remaining);
    if (!first.startsWith("'")) return first;
    // Skip past this lifetime arg + the comma separator
    const commaIdx = remaining.indexOf(',', first.length);
    if (commaIdx < 0) return first; // only lifetimes — fall through
    remaining = remaining.slice(commaIdx + 1).trim();
  }
  return args.trim();
}

const MAX_RETURN_TYPE_INPUT_LENGTH = 2048;
const MAX_RETURN_TYPE_LENGTH = 512;

export const extractReturnTypeName = (raw: string, depth = 0): string | undefined => {
  if (depth > 10) return undefined;
  if (raw.length > MAX_RETURN_TYPE_INPUT_LENGTH) return undefined;
  let text = raw.trim();
  if (!text) return undefined;

  // Strip pointer/reference prefixes: *User, &User, &mut User
  text = text.replace(/^[&*]+\s*(mut\s+)?/, '');

  // Strip nullable suffix: User?
  text = text.replace(/\?$/, '');

  // Handle union types: "User | null" → "User"
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim()).filter(p =>
      p !== 'null' && p !== 'undefined' && p !== 'void' && p !== 'None' && p !== 'nil'
    );
    if (parts.length === 1) text = parts[0];
    else return undefined; // genuine union — too complex
  }

  // Handle generics: Promise<User> → unwrap if wrapper, else take base
  const genericMatch = text.match(/^(\w+)\s*<(.+)>$/);
  if (genericMatch) {
    const [, base, args] = genericMatch;
    if (WRAPPER_GENERICS.has(base)) {
      // Take the first non-lifetime type argument, using bracket-balanced splitting
      // so that nested generics like Result<User, Error> are not split at the inner
      // comma. Lifetime parameters (Rust 'a, '_) are skipped.
      const firstArg = extractFirstTypeArg(args);
      return extractReturnTypeName(firstArg, depth + 1);
    }
    // Non-wrapper generic: return the base type (e.g., Map<K,V> → Map)
    return PRIMITIVE_TYPES.has(base.toLowerCase()) ? undefined : base;
  }

  // Bare wrapper type without generic argument (e.g. Task, Promise, Option)
  // should not produce a binding — these are meaningless without a type parameter
  if (WRAPPER_GENERICS.has(text)) return undefined;

  // Handle qualified names: models.User → User, Models::User → User, \App\Models\User → User
  if (text.includes('::') || text.includes('.') || text.includes('\\')) {
    text = text.split(/::|[.\\]/).pop()!;
  }

  // Final check: skip primitives
  if (PRIMITIVE_TYPES.has(text) || PRIMITIVE_TYPES.has(text.toLowerCase())) return undefined;

  // Must start with uppercase (class/type convention) or be a valid identifier
  if (!/^[A-Z_]\w*$/.test(text)) return undefined;

  // If the final extracted type name is too long, reject it
  if (text.length > MAX_RETURN_TYPE_LENGTH) return undefined;

  return text;
};

// ── Property declared-type extraction ────────────────────────────────────
// Shared between parse-worker (worker path) and parsing-processor (sequential path).

/**
 * Extract the declared type of a property/field from its AST definition node.
 * Handles cross-language patterns:
 * - TypeScript: `name: Type` → type_annotation child
 * - Java: `Type name` → type child on field_declaration
 * - C#: `Type Name { get; set; }` → type child on property_declaration
 * - Go: `Name Type` → type child on field_declaration
 * - Kotlin: `var name: Type` → variable_declaration child with type field
 *
 * Returns the normalized type name, or undefined if no type can be extracted.
 */
export const extractPropertyDeclaredType = (definitionNode: SyntaxNode | null): string | undefined => {
  if (!definitionNode) return undefined;

  // Strategy 1: Look for a `type` or `type_annotation` named field
  const typeNode = definitionNode.childForFieldName?.('type');
  if (typeNode) {
    const typeName = extractSimpleTypeName(typeNode);
    if (typeName) return typeName;
    // Fallback: use the raw text (for complex types like User[] or List<User>)
    const text = typeNode.text?.trim();
    if (text && text.length < 100) return text;
  }

  // Strategy 2: Walk children looking for type_annotation (TypeScript pattern)
  for (let i = 0; i < definitionNode.childCount; i++) {
    const child = definitionNode.child(i);
    if (!child) continue;
    if (child.type === 'type_annotation') {
      // Type annotation has the actual type as a child
      for (let j = 0; j < child.childCount; j++) {
        const typeChild = child.child(j);
        if (typeChild && typeChild.type !== ':') {
          const typeName = extractSimpleTypeName(typeChild);
          if (typeName) return typeName;
          const text = typeChild.text?.trim();
          if (text && text.length < 100) return text;
        }
      }
    }
  }

  // Strategy 3: For Java field_declaration, the type is a sibling of variable_declarator
  // AST: (field_declaration type: (type_identifier) declarator: (variable_declarator ...))
  const parentDecl = definitionNode.parent;
  if (parentDecl) {
    const parentType = parentDecl.childForFieldName?.('type');
    if (parentType) {
      const typeName = extractSimpleTypeName(parentType);
      if (typeName) return typeName;
    }
  }

  // Strategy 4: Kotlin property_declaration — type is nested inside variable_declaration child
  // AST: (property_declaration (variable_declaration name: ... type: (user_type ...)))
  for (let i = 0; i < definitionNode.childCount; i++) {
    const child = definitionNode.child(i);
    if (child?.type === 'variable_declaration') {
      const varType = child.childForFieldName?.('type');
      if (varType) {
        const typeName = extractSimpleTypeName(varType);
        if (typeName) return typeName;
        const text = varType.text?.trim();
        if (text && text.length < 100) return text;
      }
    }
  }

  // Strategy 5: PHP @var PHPDoc — look for preceding comment with @var Type
  // Handles pre-PHP-7.4 code: /** @var Address */ public $address;
  const prevSibling = definitionNode.previousNamedSibling ?? definitionNode.parent?.previousNamedSibling;
  if (prevSibling?.type === 'comment') {
    const commentText = prevSibling.text;
    const varMatch = commentText?.match(/@var\s+([A-Z][\w\\]*)/);
    if (varMatch) {
      // Strip namespace prefix: \App\Models\User → User
      const raw = varMatch[1];
      const base = raw.includes('\\') ? raw.split('\\').pop()! : raw;
      if (base && /^[A-Z]\w*$/.test(base)) return base;
    }
  }

  return undefined;
};
