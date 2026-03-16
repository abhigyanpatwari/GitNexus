import type { SyntaxNode } from './utils.js';
import { FUNCTION_NODE_TYPES, extractFunctionName, CLASS_CONTAINER_TYPES } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { typeConfigs, TYPED_PARAMETER_TYPES } from './type-extractors/index.js';
import type { ClassNameLookup } from './type-extractors/types.js';
import { extractSimpleTypeName } from './type-extractors/shared.js';
import type { SymbolTable } from './symbol-table.js';

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
  /** Raw per-scope type bindings — for testing and debugging. */
  readonly env: TypeEnv;
}

/** Implementation of the lookup logic — shared between TypeEnvironment and the legacy export. */
const lookupInEnv = (
  env: TypeEnv,
  varName: string,
  callNode: SyntaxNode,
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


/**
 * Walk up the AST from a node to find the enclosing class/module name.
 * Used to resolve `self`/`this` receivers to their containing type.
 */
const findEnclosingClassName = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName('name')
        ?? findTypeIdentifierChild(current);
      if (nameNode) return nameNode.text;
    }
    current = current.parent;
  }
  return undefined;
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
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      return extractParentClassFromNode(current);
    }
    current = current.parent;
  }
  return undefined;
};

/** Extract the parent/superclass name from a class declaration AST node. */
const extractParentClassFromNode = (classNode: SyntaxNode): string | undefined => {
  // 1. Named fields: Java (superclass), Ruby (superclass), Python (superclasses)
  const superclassNode = classNode.childForFieldName('superclass');
  if (superclassNode) {
    // Java: superclass > type_identifier or generic_type, Ruby: superclass > constant
    const inner = superclassNode.childForFieldName('type')
      ?? superclassNode.firstNamedChild
      ?? superclassNode;
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
      const result = symbolTable.lookupFuzzy(name).some(def => def.type === 'Class');
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
export const buildTypeEnv = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
  symbolTable?: SymbolTable,
): TypeEnvironment => {
  const env: TypeEnv = new Map();
  const localClassNames = new Set<string>();
  const classNames = createClassNameLookup(localClassNames, symbolTable);
  const config = typeConfigs[language];
  const bindings: ConstructorBinding[] = [];

  /**
   * Try to extract a (variableName → typeName) binding from a single AST node.
   *
   * Resolution tiers (first match wins):
   * - Tier 0: explicit type annotations via extractDeclaration
   * - Tier 1: constructor-call inference via extractInitializer (fallback)
   */
  const extractTypeBinding = (node: SyntaxNode, scopeEnv: Map<string, string>): void => {
    // This guard eliminates 90%+ of calls before any language dispatch.
    if (TYPED_PARAMETER_TYPES.has(node.type)) {
      config.extractParameter(node, scopeEnv);
      return;
    }
    if (config.declarationNodeTypes.has(node.type)) {
      config.extractDeclaration(node, scopeEnv);
      // Tier 1: constructor-call inference as fallback.
      // Always called when available — each language's extractInitializer
      // internally skips declarators that already have explicit annotations,
      // so this handles mixed cases like `const a: A = x, b = new B()`.
      if (config.extractInitializer) {
        config.extractInitializer(node, scopeEnv, classNames);
      }
    }
  };

  const walk = (node: SyntaxNode, currentScope: string): void => {
    // Collect class/struct names as we encounter them (used by extractInitializer
    // to distinguish constructor calls from function calls, e.g. C++ `User()` vs `getUser()`)
    // Currently only C++ uses this locally; other languages rely on the SymbolTable path.
    if (CLASS_CONTAINER_TYPES.has(node.type)) {
      // Most languages use 'name' field; Kotlin uses a type_identifier child instead
      const nameNode = node.childForFieldName('name')
        ?? findTypeIdentifierChild(node);
      if (nameNode) localClassNames.add(nameNode.text);
    }

    // Detect scope boundaries (function/method definitions)
    let scope = currentScope;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const { funcName } = extractFunctionName(node);
      if (funcName) scope = `${funcName}@${node.startIndex}`;
    }

    // Get or create the sub-map for this scope
    if (!env.has(scope)) env.set(scope, new Map());
    const scopeEnv = env.get(scope)!;

    extractTypeBinding(node, scopeEnv);

    // Scan for constructor bindings that couldn't be resolved locally.
    // Only collect if TypeEnv didn't already resolve this binding.
    if (config.scanConstructorBinding) {
      const result = config.scanConstructorBinding(node);
      if (result && !scopeEnv.has(result.varName)) {
        bindings.push({ scope, ...result });
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, scope);
    }
  };

  walk(tree.rootNode, FILE_SCOPE);
  return {
    lookup: (varName, callNode) => lookupInEnv(env, varName, callNode),
    constructorBindings: bindings,
    env,
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


