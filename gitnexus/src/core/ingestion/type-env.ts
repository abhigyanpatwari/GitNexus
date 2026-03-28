import {
  type SyntaxNode,
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  CLASS_CONTAINER_TYPES,
} from './utils/ast-helpers.js';
import { CALL_EXPRESSION_TYPES } from './utils/call-analysis.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { TYPED_PARAMETER_TYPES } from './type-extractors/shared.js';
import { getProvider } from './languages/index.js';
import type {
  ClassNameLookup,
  ReturnTypeLookup,
  ForLoopExtractorContext,
  PendingAssignment,
} from './type-extractors/types.js';
import {
  extractSimpleTypeName,
  extractVarName,
  stripNullable,
  extractReturnTypeName,
} from './type-extractors/shared.js';
import type { SymbolTable } from './symbol-table.js';
import type { NodeLabel } from 'gitnexus-shared';

/**
 * Per-file scoped type environment: maps (scope, variableName) → typeName.
 * Scope-aware: variables inside functions are keyed by function name,
 * file-level variables use the '' (empty string) scope.
 *
 * Design constraints:
 * - Explicit-only: Tier 0 uses type annotations; Tier 1 infers from constructors
 * - Tier 2: single-pass assignment chain propagation in source order — resolves
 *   `const b = a` when `a` already has a type from Tier 0/1
 * - Scope-aware: function-local variables don't collide across functions
 * - Conservative: complex/generic types extract the base name only
 * - Per-file: built once, used for receiver resolution, then discarded
 */
type TypeEnv = Map<string, Map<string, string>>;

/** File-level scope key */
const FILE_SCOPE = '';

/** Shared empty map for files with no file-scope bindings. */
const EMPTY_FILE_SCOPE: ReadonlyMap<string, string> = new Map();

/** Fallback for languages where class names aren't in a 'name' field (e.g. Kotlin uses type_identifier). */
const findTypeIdentifierChild = (node: SyntaxNode): SyntaxNode | null => {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'type_identifier') return child;
  }
  return null;
};

/**
 * Per-file type environment with receiver resolution.
 * Built once per file via `buildTypeEnv`, used for receiver-type filtering,
 * then discarded. Encapsulates scope-aware type lookup and self/this/super
 * AST resolution behind a single `.lookup()` method.
 */
export interface TypeEnvironment {
  /** Look up a variable's resolved type, with self/this/super AST resolution. */
  lookup(varName: string, callNode: SyntaxNode): string | undefined;
  /** Unverified cross-file constructor bindings for SymbolTable verification. */
  readonly constructorBindings: readonly ConstructorBinding[];
  /** Get all file-scope bindings (scope key = '') as a read-only map. */
  fileScope(): ReadonlyMap<string, string>;
  /** All scoped bindings as a read-only nested map (scope → varName → type).
   *  Use for diagnostics/testing. Prefer lookup() for production call resolution. */
  allScopes(): ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Maps `scope\0varName` → constructor type for virtual dispatch override.
   *  Populated when a variable has BOTH a declared base type AND a more specific
   *  constructor type (e.g., `Animal a = new Dog()` → key maps to 'Dog'). */
  readonly constructorTypeMap: ReadonlyMap<string, string>;
}

/**
 * Position-indexed pattern binding: active only within a specific AST range.
 * Used for smart-cast narrowing in mutually exclusive branches (e.g., Kotlin when arms).
 */
interface PatternOverride {
  rangeStart: number;
  rangeEnd: number;
  typeName: string;
}

/** scope → varName → overrides (checked in order, first range match wins) */
type PatternOverrides = Map<string, Map<string, PatternOverride[]>>;

/** AST node types that represent mutually exclusive branch containers for pattern bindings.
 *  Includes both multi-arm pattern-match branches AND if-statement bodies for null-check narrowing. */
const NARROWING_BRANCH_TYPES = new Set([
  'when_entry', // Kotlin when
  'switch_block_label', // Java switch (enhanced)
  'if_statement', // TS/JS, Java, C/C++
  'if_expression', // Kotlin (if is an expression)
  'statement_block', // TS/JS: { ... } body of if
  'control_structure_body', // Kotlin: body of if
]);

/** Walk up the AST from a pattern node to find the enclosing branch container. */
const findNarrowingBranchScope = (node: SyntaxNode): SyntaxNode | undefined => {
  let current = node.parent;
  while (current) {
    if (NARROWING_BRANCH_TYPES.has(current.type)) return current;
    if (FUNCTION_NODE_TYPES.has(current.type)) return undefined;
    current = current.parent;
  }
  return undefined;
};

/** Bare nullable keywords that fastStripNullable must reject. */
const FAST_NULLABLE_KEYWORDS = new Set(['null', 'undefined', 'void', 'None', 'nil']);

/**
 * Fast-path nullable check: 90%+ of type names are simple identifiers (e.g. "User")
 * that don't need the full stripNullable parse. Only call stripNullable when the
 * string contains nullable markers ('|' for union types, '?' for nullable suffix).
 */
const fastStripNullable = (typeName: string): string | undefined => {
  if (FAST_NULLABLE_KEYWORDS.has(typeName)) return undefined;
  return typeName.indexOf('|') === -1 && typeName.indexOf('?') === -1
    ? typeName
    : stripNullable(typeName);
};

/** Implementation of the lookup logic — shared between TypeEnvironment and the legacy export. */
const lookupInEnv = (
  env: TypeEnv,
  varName: string,
  callNode: SyntaxNode,
  patternOverrides?: PatternOverrides,
  enclosingFunctionFinder?: (n: SyntaxNode) => { funcName: string; label: NodeLabel } | null,
): string | undefined => {
  // Self/this receiver: resolve to enclosing class name via AST walk
  if (varName === 'self' || varName === 'this' || varName === '$this') {
    return findEnclosingClassName(callNode);
  }

  // Super/base/parent receiver: resolve to the parent class name via AST walk.
  // Walks up to the enclosing class, then extracts the superclass from its heritage node.
  if (varName === 'super' || varName === 'base' || varName === 'parent') {
    return findEnclosingParentClassName(callNode);
  }

  // Determine the enclosing function scope for the call
  const scopeKey = findEnclosingScopeKey(callNode, enclosingFunctionFinder);

  // Check position-indexed pattern overrides first (e.g., Kotlin when/is smart casts).
  // These take priority over flat scopeEnv because they represent per-branch narrowing.
  if (scopeKey && patternOverrides) {
    const varOverrides = patternOverrides.get(scopeKey)?.get(varName);
    if (varOverrides) {
      const pos = callNode.startIndex;
      for (const override of varOverrides) {
        if (pos >= override.rangeStart && pos <= override.rangeEnd) {
          return fastStripNullable(override.typeName);
        }
      }
    }
  }

  // Try function-local scope first
  if (scopeKey) {
    const scopeEnv = env.get(scopeKey);
    if (scopeEnv) {
      const result = scopeEnv.get(varName);
      if (result) return fastStripNullable(result);
    }
  }

  // Fall back to file-level scope
  const fileEnv = env.get(FILE_SCOPE);
  const raw = fileEnv?.get(varName);
  return raw ? fastStripNullable(raw) : undefined;
};

/** Per-file memoization caches for expensive parent-walk functions.
 *  Cleared at the start of each buildTypeEnv call (one call per file). */
const enclosingClassNameCache = new Map<SyntaxNode, string | undefined>();
const enclosingParentClassNameCache = new Map<SyntaxNode, string | undefined>();

/**
 * Walk up the AST from a node to find the enclosing class/module name.
 * Used to resolve `self`/`this` receivers to their containing type.
 * Memoized per-file: cache is cleared at buildTypeEnv entry.
 */
const findEnclosingClassName = (node: SyntaxNode): string | undefined => {
  if (enclosingClassNameCache.has(node)) return enclosingClassNameCache.get(node);
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName('name') ?? findTypeIdentifierChild(current);
      if (nameNode) {
        enclosingClassNameCache.set(node, nameNode.text);
        return nameNode.text;
      }
    }
    current = current.parent;
  }
  enclosingClassNameCache.set(node, undefined);
  return undefined;
};

/** Keywords that refer to the current instance across languages. */
const THIS_RECEIVERS = new Set(['this', 'self', '$this', 'Me']);

/**
 * If a pending assignment's receiver is this/self/$this/Me, substitute the
 * enclosing class name. Returns the item unchanged for non-receiver kinds
 * or when the receiver is not a this-keyword. Properties are readonly in the
 * discriminated union, so a new object is returned when substitution occurs.
 */
const substituteThisReceiver = (item: PendingAssignment, node: SyntaxNode): PendingAssignment => {
  if (item.kind !== 'fieldAccess' && item.kind !== 'methodCallResult') return item;
  if (!THIS_RECEIVERS.has(item.receiver)) return item;
  const className = findEnclosingClassName(node);
  if (!className) return item;
  return { ...item, receiver: className };
};

/**
 * Walk up the AST to find the enclosing class, then extract its parent class name
 * from the heritage/superclass AST node. Used to resolve `super`/`base`/`parent`.
 *
 * Supported patterns per tree-sitter grammar:
 * - Java/Ruby: `superclass` field → type_identifier/constant
 * - Python: `superclasses` field → argument_list → first identifier
 * - TypeScript/JS: unnamed `class_heritage` child → `extends_clause` → identifier
 * - C#: unnamed `base_list` child → first identifier
 * - PHP: unnamed `base_clause` child → name
 * - Kotlin: unnamed `delegation_specifier` child → constructor_invocation → user_type → type_identifier
 * - C++: unnamed `base_class_clause` child → type_identifier
 * - Swift: unnamed `inheritance_specifier` child → user_type → type_identifier
 */
const findEnclosingParentClassName = (node: SyntaxNode): string | undefined => {
  if (enclosingParentClassNameCache.has(node)) return enclosingParentClassNameCache.get(node);
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      const result = extractParentClassFromNode(current);
      enclosingParentClassNameCache.set(node, result);
      return result;
    }
    current = current.parent;
  }
  enclosingParentClassNameCache.set(node, undefined);
  return undefined;
};

/** Extract the parent/superclass name from a class declaration AST node. */
const extractParentClassFromNode = (classNode: SyntaxNode): string | undefined => {
  // 1. Named fields: Java (superclass), Ruby (superclass), Python (superclasses)
  const superclassNode = classNode.childForFieldName('superclass');
  if (superclassNode) {
    // Java: superclass > type_identifier or generic_type, Ruby: superclass > constant
    const inner =
      superclassNode.childForFieldName('type') ?? superclassNode.firstNamedChild ?? superclassNode;
    return extractSimpleTypeName(inner) ?? inner.text;
  }

  const superclassesNode = classNode.childForFieldName('superclasses');
  if (superclassesNode) {
    // Python: argument_list with identifiers or attribute nodes (e.g. models.Model)
    const first = superclassesNode.firstNamedChild;
    if (first) return extractSimpleTypeName(first) ?? first.text;
  }

  // 2. Unnamed children: walk class node's children looking for heritage nodes
  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (!child) continue;

    switch (child.type) {
      // TypeScript: class_heritage > extends_clause > type_identifier
      // JavaScript: class_heritage > identifier (no extends_clause wrapper)
      case 'class_heritage': {
        for (let j = 0; j < child.childCount; j++) {
          const clause = child.child(j);
          if (clause?.type === 'extends_clause') {
            const typeNode = clause.firstNamedChild;
            if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text;
          }
          // JS: direct identifier child (no extends_clause wrapper)
          if (clause?.type === 'identifier' || clause?.type === 'type_identifier') {
            return clause.text;
          }
        }
        break;
      }

      // C#: base_list > identifier or generic_name > identifier
      case 'base_list': {
        const first = child.firstNamedChild;
        if (first) {
          // generic_name wraps the identifier: BaseClass<T>
          if (first.type === 'generic_name') {
            const inner = first.childForFieldName('name') ?? first.firstNamedChild;
            if (inner) return inner.text;
          }
          return first.text;
        }
        break;
      }

      // PHP: base_clause > name
      case 'base_clause': {
        const name = child.firstNamedChild;
        if (name) return name.text;
        break;
      }

      // C++: base_class_clause > type_identifier (with optional access_specifier before it)
      case 'base_class_clause': {
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j);
          if (inner?.type === 'type_identifier') return inner.text;
        }
        break;
      }

      // Kotlin: delegation_specifier > constructor_invocation > user_type > type_identifier
      case 'delegation_specifier': {
        const delegate = child.firstNamedChild;
        if (delegate?.type === 'constructor_invocation') {
          const userType = delegate.firstNamedChild;
          if (userType?.type === 'user_type') {
            const typeId = userType.firstNamedChild;
            if (typeId) return typeId.text;
          }
        }
        // Also handle plain user_type (interface conformance without parentheses)
        if (delegate?.type === 'user_type') {
          const typeId = delegate.firstNamedChild;
          if (typeId) return typeId.text;
        }
        break;
      }

      // Swift: inheritance_specifier > user_type > type_identifier
      case 'inheritance_specifier': {
        const userType = child.childForFieldName('inherits_from') ?? child.firstNamedChild;
        if (userType?.type === 'user_type') {
          const typeId = userType.firstNamedChild;
          if (typeId) return typeId.text;
        }
        break;
      }
    }
  }

  return undefined;
};

/** Find the enclosing function name for scope lookup.
 *  When an `enclosingFunctionFinder` hook is provided (from the language provider),
 *  it is consulted for each ancestor before the default FUNCTION_NODE_TYPES check.
 *  This handles languages like Dart where the function body is a sibling of the
 *  signature instead of a child. */
const findEnclosingScopeKey = (
  node: SyntaxNode,
  enclosingFunctionFinder?: (n: SyntaxNode) => { funcName: string; label: NodeLabel } | null,
): string | undefined => {
  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName } = extractFunctionName(current);
      if (funcName) return `${funcName}@${current.startIndex}`;
    }
    // Language-specific hook (e.g., Dart function_body → sibling function_signature)
    if (enclosingFunctionFinder) {
      const result = enclosingFunctionFinder(current);
      if (result) {
        const sigNode = current.previousSibling;
        const startIdx = sigNode?.startIndex ?? current.startIndex;
        return `${result.funcName}@${startIdx}`;
      }
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Create a lookup that checks both local AST class names AND the SymbolTable's
 * global index. This allows extractInitializer functions to distinguish
 * constructor calls from function calls (e.g. Kotlin `User()` vs `getUser()`)
 * using cross-file type information when available.
 *
 * Only `.has()` is exposed — the SymbolTable doesn't support iteration.
 * Results are memoized to avoid redundant lookupFuzzy scans across declarations.
 */
const createClassNameLookup = (
  localNames: Set<string>,
  symbolTable?: SymbolTable,
): ClassNameLookup => {
  if (!symbolTable) return localNames;

  const memo = new Map<string, boolean>();
  return {
    has(name: string): boolean {
      if (localNames.has(name)) return true;
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const result = symbolTable
        .lookupFuzzy(name)
        .some((def) => def.type === 'Class' || def.type === 'Enum' || def.type === 'Struct');
      memo.set(name, result);
      return result;
    },
  };
};

/**
 * Build a TypeEnvironment from a tree-sitter AST for a given language.
 * Single-pass: collects class/struct names, type bindings, AND constructor
 * bindings that couldn't be resolved locally — all in one AST walk.
 *
 * When a symbolTable is provided (call-processor path), class names from across
 * the project are available for constructor inference in languages like Kotlin
 * where constructors are syntactically identical to function calls.
 */
/**
 * Node types whose subtrees can NEVER contain type-relevant descendants
 * (declarations, parameters, for-loops, class definitions, pattern bindings).
 * Conservative leaf-only set — verified safe across all 12 supported language grammars.
 * IMPORTANT: Do NOT add expression containers (arguments, binary_expression, etc.) —
 * they can contain arrow functions with typed parameters.
 */
const SKIP_SUBTREE_TYPES = new Set([
  // Plain string literals (NOT template_string — it contains interpolated expressions
  // that can hold arrow functions with typed parameters, e.g. `${(x: T) => x}`)
  'string',
  'string_literal',
  'string_content',
  'string_fragment',
  'heredoc_body',
  // Comments
  'comment',
  'line_comment',
  'block_comment',
  // Numeric/boolean/null literals
  'number',
  'integer_literal',
  'float_literal',
  'true',
  'false',
  'null',
  // Regex
  'regex',
  'regex_pattern',
]);

const CLASS_LIKE_TYPES = new Set(['Class', 'Struct', 'Interface']);

/** Memoize class definition lookups during fixpoint iteration.
 *  SymbolTable is immutable during type resolution, so results never change.
 *  Eliminates redundant array allocations + filter scans across iterations. */
const createClassDefCache = (symbolTable?: SymbolTable) => {
  const cache = new Map<string, Array<{ nodeId: string; type: string }>>();
  return (typeName: string) => {
    let result = cache.get(typeName);
    if (result === undefined) {
      result = symbolTable
        ? symbolTable.lookupFuzzy(typeName).filter((d) => CLASS_LIKE_TYPES.has(d.type))
        : [];
      cache.set(typeName, result);
    }
    return result;
  };
};

/** AST node types representing constructor expressions across languages.
 *  Note: C# also has `implicit_object_creation_expression` (`new()` with type
 *  inference) which is NOT captured — the type is inferred, not explicit.
 *  Kotlin constructors use `call_expression` (no `new` keyword) — not detected. */
const CONSTRUCTOR_EXPR_TYPES = new Set([
  'new_expression', // TS/JS/C++: new Dog()
  'object_creation_expression', // Java/C#: new Dog()
]);

/** Extract the constructor class name from a declaration node's initializer.
 *  Searches for new_expression / object_creation_expression in the node's subtree.
 *  Returns the class name or undefined if no constructor is found.
 *  Depth-limited to 5 to avoid expensive traversals. */
const extractConstructorTypeName = (node: SyntaxNode, depth = 0): string | undefined => {
  if (depth > 5) return undefined;
  if (CONSTRUCTOR_EXPR_TYPES.has(node.type)) {
    // Java/C#: object_creation_expression has 'type' field
    const typeField = node.childForFieldName('type');
    if (typeField) return extractSimpleTypeName(typeField);
    // TS/JS: new_expression has 'constructor' field (but tree-sitter often just has identifier child)
    const ctorField = node.childForFieldName('constructor');
    if (ctorField) return extractSimpleTypeName(ctorField);
    // Fallback: first named child is often the class identifier
    if (node.firstNamedChild) return extractSimpleTypeName(node.firstNamedChild);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    // Don't descend into nested functions/classes or call expressions (prevents
    // finding constructor args inside method calls, e.g. processAll(new Dog()))
    if (
      FUNCTION_NODE_TYPES.has(child.type) ||
      CLASS_CONTAINER_TYPES.has(child.type) ||
      CALL_EXPRESSION_TYPES.has(child.type)
    )
      continue;
    const result = extractConstructorTypeName(child, depth + 1);
    if (result) return result;
  }
  return undefined;
};

/** Max depth for MRO parent chain walking. Real-world inheritance rarely exceeds 3-4 levels. */
const MAX_MRO_DEPTH = 5;

/** Check if `child` is a subclass of `parent` using the parentMap.
 *  BFS up from child, depth-limited (5), cycle-safe. */
export const isSubclassOf = (
  child: string,
  parent: string,
  parentMap: ReadonlyMap<string, readonly string[]> | undefined,
): boolean => {
  if (!parentMap || child === parent) return false;
  const visited = new Set<string>([child]);
  let current = [child];
  for (let depth = 0; depth < MAX_MRO_DEPTH && current.length > 0; depth++) {
    const next: string[] = [];
    for (const cls of current) {
      const parents = parentMap.get(cls);
      if (!parents) continue;
      for (const p of parents) {
        if (p === parent) return true;
        if (!visited.has(p)) {
          visited.add(p);
          next.push(p);
        }
      }
    }
    current = next;
  }
  return false;
};

/** Walk up the parent class chain to find a field or method on an ancestor.
 *  BFS-like traversal with depth limit and cycle detection. First match wins.
 *  Used by resolveFieldType and resolveMethodReturnType when direct lookup fails. */
const walkParentChain = <T>(
  typeName: string,
  parentMap: ReadonlyMap<string, readonly string[]> | undefined,
  getClassDefs: (name: string) => Array<{ nodeId: string; type: string }>,
  lookupOnClass: (nodeId: string) => T | undefined,
): T | undefined => {
  if (!parentMap) return undefined;
  const visited = new Set<string>([typeName]);
  let current = [typeName];
  for (let depth = 0; depth < MAX_MRO_DEPTH && current.length > 0; depth++) {
    const next: string[] = [];
    for (const cls of current) {
      const parents = parentMap.get(cls);
      if (!parents) continue;
      for (const parent of parents) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        const parentDefs = getClassDefs(parent);
        if (parentDefs.length === 1) {
          const result = lookupOnClass(parentDefs[0].nodeId);
          if (result !== undefined) return result;
        }
        next.push(parent);
      }
    }
    current = next;
  }
  return undefined;
};

/** Resolve a field's declared type given a receiver variable and field name.
 *  Uses SymbolTable to find the class nodeId for the receiver's type, then
 *  looks up the field via the eagerly-populated fieldByOwner index.
 *  Falls back to MRO parent chain walking if direct lookup fails (Phase 11A). */
const resolveFieldType = (
  receiver: string,
  field: string,
  scopeEnv: ReadonlyMap<string, string>,
  symbolTable?: SymbolTable,
  getClassDefs?: (typeName: string) => Array<{ nodeId: string; type: string }>,
  parentMap?: ReadonlyMap<string, readonly string[]>,
): string | undefined => {
  if (!symbolTable) return undefined;
  const receiverType = scopeEnv.get(receiver);
  if (!receiverType) return undefined;
  const lookup =
    getClassDefs ??
    ((name: string) => symbolTable.lookupFuzzy(name).filter((d) => CLASS_LIKE_TYPES.has(d.type)));
  const classDefs = lookup(receiverType);
  if (classDefs.length !== 1) return undefined;
  // Direct lookup first
  const fieldDef = symbolTable.lookupFieldByOwner(classDefs[0].nodeId, field);
  if (fieldDef?.declaredType) return extractReturnTypeName(fieldDef.declaredType);
  // MRO parent chain walking on miss
  const inherited = walkParentChain(receiverType, parentMap, lookup, (nodeId) => {
    const f = symbolTable.lookupFieldByOwner(nodeId, field);
    return f?.declaredType ? extractReturnTypeName(f.declaredType) : undefined;
  });
  return inherited;
};

/** Resolve a method's return type given a receiver variable and method name.
 *  Uses SymbolTable to find class nodeIds for the receiver's type, then
 *  looks up the method via lookupFuzzyCallable filtered by ownerId.
 *  Falls back to MRO parent chain walking if direct lookup fails (Phase 11A). */
const resolveMethodReturnType = (
  receiver: string,
  method: string,
  scopeEnv: ReadonlyMap<string, string>,
  symbolTable?: SymbolTable,
  getClassDefs?: (typeName: string) => Array<{ nodeId: string; type: string }>,
  parentMap?: ReadonlyMap<string, readonly string[]>,
): string | undefined => {
  if (!symbolTable) return undefined;
  const receiverType = scopeEnv.get(receiver);
  if (!receiverType) return undefined;
  const lookup =
    getClassDefs ??
    ((name: string) => symbolTable.lookupFuzzy(name).filter((d) => CLASS_LIKE_TYPES.has(d.type)));
  const classDefs = lookup(receiverType);
  if (classDefs.length === 0) return undefined;
  // Direct lookup first
  const classNodeIds = new Set(classDefs.map((d) => d.nodeId));
  const methods = symbolTable
    .lookupFuzzyCallable(method)
    .filter((d) => d.ownerId && classNodeIds.has(d.ownerId));
  if (methods.length === 1 && methods[0].returnType) {
    return extractReturnTypeName(methods[0].returnType);
  }
  // MRO parent chain walking on miss
  if (methods.length === 0) {
    const inherited = walkParentChain(receiverType, parentMap, lookup, (nodeId) => {
      const parentMethods = symbolTable
        .lookupFuzzyCallable(method)
        .filter((d) => d.ownerId === nodeId);
      if (parentMethods.length !== 1 || !parentMethods[0].returnType) return undefined;
      return extractReturnTypeName(parentMethods[0].returnType);
    });
    return inherited;
  }
  return undefined;
};

/**
 * Unified fixpoint propagation: iterate over ALL pending items (copy, callResult,
 * fieldAccess, methodCallResult) until no new bindings are produced.
 * Handles arbitrary-depth mixed chains:
 *   const user = getUser();      // callResult → User
 *   const addr = user.address;   // fieldAccess → Address (depends on user)
 *   const city = addr.getCity(); // methodCallResult → City (depends on addr)
 *   const alias = city;          // copy → City (depends on city)
 * Data flow: SymbolTable (immutable) + scopeEnv → resolve → scopeEnv.
 * Termination: finite entries, each bound at most once (first-writer-wins), max 10 iterations.
 */
const MAX_FIXPOINT_ITERATIONS = 10;

const resolveFixpointBindings = (
  pendingItems: Array<{ scope: string } & PendingAssignment>,
  env: TypeEnv,
  returnTypeLookup: ReturnTypeLookup,
  symbolTable?: SymbolTable,
  parentMap?: ReadonlyMap<string, readonly string[]>,
): void => {
  if (pendingItems.length === 0) return;
  const getClassDefs = createClassDefCache(symbolTable);
  const resolved = new Set<number>();
  for (let iter = 0; iter < MAX_FIXPOINT_ITERATIONS; iter++) {
    let changed = false;
    for (let i = 0; i < pendingItems.length; i++) {
      if (resolved.has(i)) continue;
      const item = pendingItems[i];
      const scopeEnv = env.get(item.scope);
      if (!scopeEnv || scopeEnv.has(item.lhs)) {
        resolved.add(i);
        continue;
      }

      let typeName: string | undefined;
      switch (item.kind) {
        case 'callResult':
          // Phase 9: Prefer FQN lookup when available for higher precision
          typeName = item.calleeFqn
            ? returnTypeLookup.lookupReturnType(item.calleeFqn)
            : returnTypeLookup.lookupReturnType(item.callee);
          break;
        case 'copy':
          typeName = scopeEnv.get(item.rhs) ?? env.get(FILE_SCOPE)?.get(item.rhs);
          break;
        case 'fieldAccess':
          typeName = resolveFieldType(
            item.receiver,
            item.field,
            scopeEnv,
            symbolTable,
            getClassDefs,
            parentMap,
          );
          break;
        case 'methodCallResult':
          typeName = resolveMethodReturnType(
            item.receiver,
            item.method,
            scopeEnv,
            symbolTable,
            getClassDefs,
            parentMap,
          );
          break;
        default: {
          // Exhaustive check: TypeScript will error here if a new PendingAssignment
          // kind is added without handling it in the switch.
          const _exhaustive: never = item;
          break;
        }
      }
      if (typeName) {
        scopeEnv.set(item.lhs, typeName);
        resolved.add(i);
        changed = true;
      }
    }
    if (!changed) break;
    if (iter === MAX_FIXPOINT_ITERATIONS - 1 && process.env.GITNEXUS_DEBUG) {
      const unresolved = pendingItems.length - resolved.size;
      if (unresolved > 0) {
        console.warn(
          `[type-env] fixpoint hit iteration cap (${MAX_FIXPOINT_ITERATIONS}), ${unresolved} items unresolved`,
        );
      }
    }
  }
};

/**
 * Options for buildTypeEnv.
 * Uses an options object to allow future extensions without positional parameter sprawl.
 */
export interface BuildTypeEnvOptions {
  symbolTable?: SymbolTable;
  parentMap?: ReadonlyMap<string, readonly string[]>;
  /** Pre-resolved bindings from upstream files (Phase 14).
   *  Seeded into FILE_SCOPE after walk() for names with no local binding.
   *  Local declarations always take precedence (first-writer-wins). */
  importedBindings?: ReadonlyMap<string, string>;
  /** Cross-file return type fallback for imported callables (Phase 14 E3).
   *  Consulted ONLY when SymbolTable has no unambiguous match.
   *  Local definitions always take precedence (local-first principle). */
  importedReturnTypes?: ReadonlyMap<string, string>;
  /** Cross-file RAW return types for imported callables (Phase 14 E3).
   *  Stores raw declared return type strings (e.g., 'User[]', 'List<User>').
   *  Used by lookupRawReturnType for for-loop element extraction. */
  importedRawReturnTypes?: ReadonlyMap<string, string>;
  /** Language-specific enclosing function resolver for scope key lookup.
   *  Same hook as LanguageProvider.enclosingFunctionFinder — handles languages
   *  where function_body is a sibling of the signature (e.g., Dart). */
  enclosingFunctionFinder?: (
    ancestorNode: SyntaxNode,
  ) => { funcName: string; label: NodeLabel } | null;
}

/** Seed cross-file type bindings into the file scope.
 *  MUST be called AFTER walk() completes so that local declarations
 *  (Tier 0/1) always take precedence over imported bindings (first-writer-wins). */
function seedImportedBindings(env: TypeEnv, importedBindings: ReadonlyMap<string, string>): void {
  let fileEnv = env.get(FILE_SCOPE);
  if (!fileEnv) {
    fileEnv = new Map();
    env.set(FILE_SCOPE, fileEnv);
  }
  for (const [name, type] of importedBindings) {
    if (!fileEnv.has(name)) {
      fileEnv.set(name, type);
    }
  }
}

export const buildTypeEnv = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
  options?: BuildTypeEnvOptions,
): TypeEnvironment => {
  // Clear per-file memoization caches from the previous file.
  enclosingClassNameCache.clear();
  enclosingParentClassNameCache.clear();

  const symbolTable = options?.symbolTable;
  const parentMap = options?.parentMap;
  const env: TypeEnv = new Map();
  const patternOverrides: PatternOverrides = new Map();
  // Phase P: maps `scope\0varName` → constructor type when a declaration has BOTH
  // a base type annotation AND a more specific constructor initializer.
  // e.g., `Animal a = new Dog()` → constructorTypeMap.set('func@42\0a', 'Dog')
  const constructorTypeMap = new Map<string, string>();
  const localClassNames = new Set<string>();
  const classNames = createClassNameLookup(localClassNames, symbolTable);
  const provider = getProvider(language);
  const config = provider.typeConfig;
  const bindings: ConstructorBinding[] = [];

  // Build ReturnTypeLookup: SymbolTable is authoritative when it has an unambiguous match.
  // Cross-file importedReturnTypes are consulted ONLY when SymbolTable has 0 matches.
  // Ambiguous (2+) → undefined, no cross-file fallback (conservative, local-first principle).
  const returnTypeLookup: ReturnTypeLookup = {
    lookupReturnType(callee: string): string | undefined {
      // SymbolTable is authoritative when it has an unambiguous match
      if (symbolTable) {
        if (provider.isBuiltInName(callee)) return undefined;
        const callables = symbolTable.lookupFuzzyCallable(callee);
        if (callables.length === 1) {
          const rawReturn = callables[0].returnType;
          if (rawReturn) return extractReturnTypeName(rawReturn);
        }
        // Ambiguous (2+) → return undefined (conservative, no cross-file fallback)
        if (callables.length > 1) return undefined;
      }
      // No match (0 results or no symbolTable) → fall back to cross-file
      return options?.importedReturnTypes?.get(callee);
    },
    lookupRawReturnType(callee: string): string | undefined {
      if (symbolTable) {
        if (provider.isBuiltInName(callee)) return undefined;
        const callables = symbolTable.lookupFuzzyCallable(callee);
        if (callables.length === 1) return callables[0].returnType;
        // Ambiguous (2+) → return undefined (conservative, no cross-file fallback)
        if (callables.length > 1) return undefined;
      }
      // Cross-file fallback uses importedRawReturnTypes (raw declared types, e.g., 'User[]')
      // NOT importedReturnTypes (which contains processed/simple types via extractReturnTypeName)
      return options?.importedRawReturnTypes?.get(callee);
    },
  };

  // Pre-compute combined set of node types that need extractTypeBinding.
  // Single Set.has() replaces 3 separate checks per node in walk().
  const interestingNodeTypes = new Set<string>();
  TYPED_PARAMETER_TYPES.forEach((t) => interestingNodeTypes.add(t));
  config.declarationNodeTypes.forEach((t) => interestingNodeTypes.add(t));
  config.forLoopNodeTypes?.forEach((t) => interestingNodeTypes.add(t));
  // Tier 2: unified fixpoint propagation — collects copy, callResult, fieldAccess, and
  // methodCallResult items during walk(), then iterates until no new bindings are produced.
  // Handles arbitrary-depth mixed chains: callResult → fieldAccess → methodCallResult → copy.
  const pendingItems: Array<{ scope: string } & PendingAssignment> = [];
  // For-loop nodes whose iterable was unresolved at walk-time. Replayed after the fixpoint
  // resolves the iterable's type, bridging the walk-time/fixpoint gap (Phase 10 / ex-9B).
  const pendingForLoops: Array<{ node: SyntaxNode; scope: string }> = [];
  // Maps `scope\0varName` → the type annotation AST node from the original declaration.
  // Allows pattern extractors to navigate back to the declaration's generic type arguments
  // (e.g., to extract T from Result<T, E> for `if let Ok(x) = res`).
  // NOTE: This is a SUPERSET of scopeEnv — entries exist even when extractSimpleTypeName
  // returns undefined for container types (User[], []User, List[User]). This is intentional:
  // for-loop Strategy 1 needs the raw AST type node for exactly those container types.
  const declarationTypeNodes = new Map<string, SyntaxNode>();

  /**
   * Try to extract a (variableName → typeName) binding from a single AST node.
   *
   * Resolution tiers (first match wins):
   * - Tier 0: explicit type annotations via extractDeclaration / extractForLoopBinding
   * - Tier 1: constructor-call inference via extractInitializer (fallback)
   *
   * Side effect: populates declarationTypeNodes for variables that have an explicit
   * type annotation field on the declaration node. This allows pattern extractors to
   * retrieve generic type arguments from the original declaration (e.g., extracting T
   * from Result<T, E> for `if let Ok(x) = res`).
   */
  const extractTypeBinding = (
    node: SyntaxNode,
    scopeEnv: Map<string, string>,
    scope: string,
  ): void => {
    // This guard eliminates 90%+ of calls before any language dispatch.
    if (TYPED_PARAMETER_TYPES.has(node.type)) {
      // Capture the raw type annotation BEFORE extractParameter.
      // Most languages use 'name' field; Rust uses 'pattern'; TS uses 'pattern' for some param types.
      // Kotlin `parameter` nodes use positional children instead of named fields,
      // so we fall back to scanning children by type when childForFieldName returns null.
      let typeNode = node.childForFieldName('type');
      if (typeNode) {
        const nameNode =
          node.childForFieldName('name') ??
          node.childForFieldName('pattern') ??
          // Python typed_parameter: name is a positional child (identifier), not a named field
          (node.firstNamedChild?.type === 'identifier' ? node.firstNamedChild : null);
        if (nameNode) {
          const varName = extractVarName(nameNode);
          if (varName && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
            declarationTypeNodes.set(`${scope}\0${varName}`, typeNode);
          }
        }
      } else {
        // Fallback: positional children (Kotlin `parameter` → simple_identifier + user_type)
        let fallbackName: SyntaxNode | null = null;
        let fallbackType: SyntaxNode | null = null;
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;
          if (
            !fallbackName &&
            (child.type === 'simple_identifier' || child.type === 'identifier')
          ) {
            fallbackName = child;
          }
          if (
            !fallbackType &&
            (child.type === 'user_type' ||
              child.type === 'type_identifier' ||
              child.type === 'generic_type' ||
              child.type === 'parameterized_type' ||
              child.type === 'nullable_type')
          ) {
            fallbackType = child;
          }
        }
        if (fallbackName && fallbackType) {
          const varName = extractVarName(fallbackName);
          if (varName && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
            declarationTypeNodes.set(`${scope}\0${varName}`, fallbackType);
          }
        }
      }
      config.extractParameter(node, scopeEnv);
      return;
    }
    // For-each loop variable bindings (Java/C#/Kotlin): explicit element types in the AST.
    // Checked before declarationNodeTypes — loop variables are not declarations.
    if (config.forLoopNodeTypes?.has(node.type)) {
      if (config.extractForLoopBinding) {
        const sizeBefore = scopeEnv.size;
        const forLoopCtx: ForLoopExtractorContext = {
          scopeEnv,
          declarationTypeNodes,
          scope,
          returnTypeLookup,
        };
        config.extractForLoopBinding(node, forLoopCtx);
        // If no new binding was produced, the iterable's type may not yet be resolved.
        // Store for post-fixpoint replay (Phase 10 / ex-9B loop-fixpoint bridge).
        if (scopeEnv.size === sizeBefore) {
          pendingForLoops.push({ node, scope });
        }
      }
      return;
    }
    if (config.declarationNodeTypes.has(node.type)) {
      // Capture the raw type annotation AST node BEFORE extractDeclaration.
      // This decouples type node capture from scopeEnv success — container types
      // (User[], []User, List[User]) that fail extractSimpleTypeName still get
      // their AST type node recorded for Strategy 1 for-loop resolution.
      // Try direct extraction first (works for Go var_spec, Python assignment, Rust let_declaration).
      // Try direct type field first, then unwrap wrapper nodes (C# field_declaration,
      // local_declaration_statement wrap their type inside a variable_declaration child).
      let typeNode = node.childForFieldName('type');
      if (!typeNode) {
        // C# field_declaration / local_declaration_statement wrap type inside variable_declaration.
        // Use manual loop instead of namedChildren.find() to avoid array allocation on hot path.
        let wrapped = node.childForFieldName('declaration');
        if (!wrapped) {
          for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c?.type === 'variable_declaration') {
              wrapped = c;
              break;
            }
          }
        }
        if (wrapped) {
          typeNode = wrapped.childForFieldName('type');
          // Kotlin: variable_declaration stores the type as user_type / nullable_type
          // child rather than a named 'type' field.
          if (!typeNode) {
            for (let i = 0; i < wrapped.namedChildCount; i++) {
              const c = wrapped.namedChild(i);
              if (c && (c.type === 'user_type' || c.type === 'nullable_type')) {
                typeNode = c;
                break;
              }
            }
          }
        }
        // Swift: property_declaration has type_annotation as a direct child (not a 'type' field).
        // Extract the inner type node (array_type, user_type, etc.) for declarationTypeNodes.
        if (!typeNode) {
          for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (c?.type === 'type_annotation') {
              // Use the inner type (array_type, user_type) rather than the annotation wrapper
              typeNode = c.firstNamedChild ?? c;
              break;
            }
          }
        }
      }
      if (typeNode) {
        const nameNode =
          node.childForFieldName('name') ??
          node.childForFieldName('left') ??
          node.childForFieldName('pattern');
        if (nameNode) {
          const varName = extractVarName(nameNode);
          if (varName && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
            declarationTypeNodes.set(`${scope}\0${varName}`, typeNode);
          }
        }
      }
      // Run the language-specific declaration extractor (may or may not add to scopeEnv).
      const sizeBefore = typeNode ? scopeEnv.size : -1;
      config.extractDeclaration(node, scopeEnv);
      // Fallback: for multi-declarator languages (TS, C#, Java) where the type field
      // is on variable_declarator children, capture newly-added keys.
      // Map preserves insertion order, so new keys are always at the end —
      // skip the first sizeBefore entries to find only newly-added variables.
      if (sizeBefore >= 0 && scopeEnv.size > sizeBefore) {
        let skip = sizeBefore;
        for (const varName of scopeEnv.keys()) {
          if (skip > 0) {
            skip--;
            continue;
          }
          if (!declarationTypeNodes.has(`${scope}\0${varName}`)) {
            declarationTypeNodes.set(`${scope}\0${varName}`, typeNode);
          }
        }
      }
      // Tier 1: constructor-call inference as fallback.
      // Always called when available — each language's extractInitializer
      // internally skips declarators that already have explicit annotations,
      // so this handles mixed cases like `const a: A = x, b = new B()`.
      if (config.extractInitializer) {
        config.extractInitializer(node, scopeEnv, classNames);
      }

      // Phase P: detect constructor-visible virtual dispatch.
      // When a declaration has BOTH a type annotation AND a constructor initializer,
      // record the constructor type for receiver override at call resolution time.
      // e.g., `Animal a = new Dog()` → constructorTypeMap.set('scope\0a', 'Dog')
      if (sizeBefore >= 0 && scopeEnv.size > sizeBefore) {
        let ctorSkip = sizeBefore;
        for (const varName of scopeEnv.keys()) {
          if (ctorSkip > 0) {
            ctorSkip--;
            continue;
          }
          const declaredType = scopeEnv.get(varName);
          if (!declaredType) continue;
          const ctorType =
            extractConstructorTypeName(node) ?? config.detectConstructorType?.(node, classNames);
          if (!ctorType || ctorType === declaredType) continue;
          // Unwrap wrapper types (e.g., C++ shared_ptr<Animal> → Animal) for an
          // accurate isSubclassOf comparison. Language-specific via config hook.
          const declTypeNode = declarationTypeNodes.get(`${scope}\0${varName}`);
          const effectiveDeclaredType =
            declTypeNode && config.unwrapDeclaredType
              ? (config.unwrapDeclaredType(declaredType, declTypeNode) ?? declaredType)
              : declaredType;
          if (ctorType !== effectiveDeclaredType) {
            constructorTypeMap.set(`${scope}\0${varName}`, ctorType);
          }
        }
      }
    }
  };

  const walk = (node: SyntaxNode, currentScope: string): void => {
    // Fast skip: subtrees that can never contain type-relevant nodes (leaf-like literals).
    if (SKIP_SUBTREE_TYPES.has(node.type)) return;

    // Collect class/struct names as we encounter them (used by extractInitializer
    // to distinguish constructor calls from function calls, e.g. C++ `User()` vs `getUser()`)
    // Currently only C++ uses this locally; other languages rely on the SymbolTable path.
    if (CLASS_CONTAINER_TYPES.has(node.type)) {
      // Most languages use 'name' field; Kotlin uses a type_identifier child instead
      const nameNode = node.childForFieldName('name') ?? findTypeIdentifierChild(node);
      if (nameNode) localClassNames.add(nameNode.text);
    }

    // Detect scope boundaries (function/method definitions)
    let scope = currentScope;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const { funcName } = extractFunctionName(node);
      if (funcName) scope = `${funcName}@${node.startIndex}`;
    }

    // Only create scope map and call extractTypeBinding for interesting node types.
    // Single Set.has() replaces 3 separate checks inside extractTypeBinding.
    if (interestingNodeTypes.has(node.type)) {
      if (!env.has(scope)) env.set(scope, new Map());
      const scopeEnv = env.get(scope)!;
      extractTypeBinding(node, scopeEnv, scope);
    }

    // Pattern binding extraction: handles constructs that introduce NEW typed variables
    // via pattern matching (e.g. `if let Some(x) = opt`, `x instanceof T t`)
    // or narrow existing variables within a branch (null-check narrowing).
    // Runs after Tier 0/1 so scopeEnv already contains the source variable's type.
    // Conservative: extractor returns undefined when source type is unknown.
    if (
      config.extractPatternBinding &&
      (!config.patternBindingNodeTypes || config.patternBindingNodeTypes.has(node.type))
    ) {
      // Ensure scopeEnv exists for pattern binding reads/writes
      if (!env.has(scope)) env.set(scope, new Map());
      const scopeEnv = env.get(scope)!;
      const patternBinding = config.extractPatternBinding(
        node,
        scopeEnv,
        declarationTypeNodes,
        scope,
      );
      if (patternBinding) {
        if (patternBinding.narrowingRange) {
          // Explicit narrowing range (null-check narrowing): always store in patternOverrides
          // using the extractor-provided range (typically the if-body block).
          if (!patternOverrides.has(scope)) patternOverrides.set(scope, new Map());
          const varMap = patternOverrides.get(scope)!;
          if (!varMap.has(patternBinding.varName)) varMap.set(patternBinding.varName, []);
          varMap.get(patternBinding.varName)!.push({
            rangeStart: patternBinding.narrowingRange.startIndex,
            rangeEnd: patternBinding.narrowingRange.endIndex,
            typeName: patternBinding.typeName,
          });
        } else if (config.allowPatternBindingOverwrite) {
          // Position-indexed: store per-branch binding for smart-cast narrowing.
          // Each when arm / switch case gets its own type for the variable,
          // preventing cross-arm contamination (e.g., Kotlin when/is).
          const branchNode = findNarrowingBranchScope(node);
          if (branchNode) {
            if (!patternOverrides.has(scope)) patternOverrides.set(scope, new Map());
            const varMap = patternOverrides.get(scope)!;
            if (!varMap.has(patternBinding.varName)) varMap.set(patternBinding.varName, []);
            varMap.get(patternBinding.varName)!.push({
              rangeStart: branchNode.startIndex,
              rangeEnd: branchNode.endIndex,
              typeName: patternBinding.typeName,
            });
          }
          // Also store in flat scopeEnv as fallback (last arm wins — same as before
          // for code that doesn't use position-indexed lookup).
          scopeEnv.set(patternBinding.varName, patternBinding.typeName);
        } else if (!scopeEnv.has(patternBinding.varName)) {
          // First-writer-wins for languages without smart-cast overwrite (Java instanceof, etc.)
          scopeEnv.set(patternBinding.varName, patternBinding.typeName);
        }
      }
    }

    // Tier 2: collect plain-identifier RHS assignments for post-walk propagation.
    // Delegates to per-language extractPendingAssignment — AST shapes differ widely
    // (JS uses variable_declarator/name/value, Rust uses let_declaration/pattern/value,
    // Python uses assignment/left/right, Go uses short_var_declaration/expression_list).
    // May return a single item or an array (for destructuring: N fieldAccess items).
    if (config.extractPendingAssignment && config.declarationNodeTypes.has(node.type)) {
      // scopeEnv is guaranteed to exist here because declarationNodeTypes is a subset
      // of interestingNodeTypes, so extractTypeBinding already created the scope map above.
      const scopeEnv = env.get(scope);
      if (scopeEnv) {
        const pending = config.extractPendingAssignment(node, scopeEnv);
        if (pending) {
          const items = Array.isArray(pending) ? pending : [pending];
          for (const item of items) {
            // Substitute this/self/$this/Me receivers with enclosing class name
            const resolved = substituteThisReceiver(item, node);
            pendingItems.push({ scope, ...resolved });
          }
        }
      }
    }

    // Scan for constructor bindings that couldn't be resolved locally.
    // Only collect if TypeEnv didn't already resolve this binding.
    if (config.scanConstructorBinding) {
      const result = config.scanConstructorBinding(node);
      if (result) {
        const scopeEnv = env.get(scope);
        if (!scopeEnv?.has(result.varName)) {
          bindings.push({ scope, ...result });
        }
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, scope);
    }
  };

  walk(tree.rootNode, FILE_SCOPE);

  // Phase 14: Seed cross-file bindings from upstream files AFTER walk
  // (local declarations from walk() take precedence — first-writer-wins)
  if (options?.importedBindings && options.importedBindings.size > 0) {
    seedImportedBindings(env, options.importedBindings);
  }

  resolveFixpointBindings(pendingItems, env, returnTypeLookup, symbolTable, parentMap);

  // Post-fixpoint for-loop replay (Phase 10 / ex-9B loop-fixpoint bridge):
  // For-loop nodes whose iterables were unresolved at walk-time may now be
  // resolvable because the fixpoint bound the iterable's type.
  // Example: `const users = getUsers(); for (const u of users) { u.save(); }`
  //   - walk-time: users untyped → u unresolved
  //   - fixpoint: users → User[]
  //   - replay: users now typed → u → User
  if (pendingForLoops.length > 0 && config.extractForLoopBinding) {
    for (const { node, scope } of pendingForLoops) {
      if (!env.has(scope)) env.set(scope, new Map());
      const scopeEnv = env.get(scope)!;
      config.extractForLoopBinding(node, {
        scopeEnv,
        declarationTypeNodes,
        scope,
        returnTypeLookup,
      });
    }
    // Re-run the main fixpoint to resolve items that depended on loop variables.
    // Only needed if replay actually produced new bindings.
    const unresolvedBefore = pendingItems.filter((item) => {
      const scopeEnv = env.get(item.scope);
      return scopeEnv && !scopeEnv.has(item.lhs);
    });
    if (unresolvedBefore.length > 0) {
      resolveFixpointBindings(unresolvedBefore, env, returnTypeLookup, symbolTable);
    }
  }

  return {
    lookup: (varName, callNode) =>
      lookupInEnv(env, varName, callNode, patternOverrides, options?.enclosingFunctionFinder),
    constructorBindings: bindings,
    fileScope: () => env.get(FILE_SCOPE) ?? EMPTY_FILE_SCOPE,
    allScopes: () => env as ReadonlyMap<string, ReadonlyMap<string, string>>,
    constructorTypeMap,
  };
};

/**
 * Unverified constructor binding: a `val x = Callee()` pattern where we
 * couldn't confirm the callee is a class (because it's defined in another file).
 * The caller must verify `calleeName` against the SymbolTable before trusting.
 */
export interface ConstructorBinding {
  /** Function scope key (matches TypeEnv scope keys) */
  scope: string;
  /** Variable name that received the constructor result */
  varName: string;
  /** Name of the callee (potential class constructor) */
  calleeName: string;
  /** Enclosing class name when callee is a method on a known receiver (e.g. $this) */
  receiverClassName?: string;
}
