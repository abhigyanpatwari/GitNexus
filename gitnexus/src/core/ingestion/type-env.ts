import type { SyntaxNode } from './utils.js';
import { FUNCTION_NODE_TYPES, extractFunctionName, CLASS_CONTAINER_TYPES, isBuiltInOrNoise } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { typeConfigs, TYPED_PARAMETER_TYPES } from './type-extractors/index.js';
import type { ClassNameLookup, ReturnTypeLookup, ForLoopExtractorContext } from './type-extractors/types.js';
import { extractSimpleTypeName, extractVarName, stripNullable, extractReturnTypeName } from './type-extractors/shared.js';
import type { SymbolTable } from './symbol-table.js';

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

/** AST node types that represent mutually exclusive branch containers for pattern bindings. */
const PATTERN_BRANCH_TYPES = new Set([
  'when_entry',          // Kotlin when
  'switch_block_label',  // Java switch (enhanced)
]);

/** Walk up the AST from a pattern node to find the enclosing branch container. */
const findPatternBranchScope = (node: SyntaxNode): SyntaxNode | undefined => {
  let current = node.parent;
  while (current) {
    if (PATTERN_BRANCH_TYPES.has(current.type)) return current;
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
  return (typeName.indexOf('|') === -1 && typeName.indexOf('?') === -1)
    ? typeName
    : stripNullable(typeName);
};

/** Implementation of the lookup logic — shared between TypeEnvironment and the legacy export. */
const lookupInEnv = (
  env: TypeEnv,
  varName: string,
  callNode: SyntaxNode,
  patternOverrides?: PatternOverrides,
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
      const result = symbolTable.lookupFuzzy(name).some(def =>
        def.type === 'Class' || def.type === 'Enum' || def.type === 'Struct',
      );
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
  'string',              'string_literal',
  'string_content',      'string_fragment',      'heredoc_body',
  // Comments
  'comment',             'line_comment',         'block_comment',
  // Numeric/boolean/null literals
  'number',              'integer_literal',      'float_literal',
  'true',                'false',                'null',
  // Regex
  'regex',               'regex_pattern',
]);

export const buildTypeEnv = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
  symbolTable?: SymbolTable,
): TypeEnvironment => {
  const env: TypeEnv = new Map();
  const patternOverrides: PatternOverrides = new Map();
  const localClassNames = new Set<string>();
  const classNames = createClassNameLookup(localClassNames, symbolTable);
  const config = typeConfigs[language];
  const bindings: ConstructorBinding[] = [];

  // Build ReturnTypeLookup from optional SymbolTable.
  // Conservative: returns undefined when callee is ambiguous (0 or 2+ matches).
  const returnTypeLookup: ReturnTypeLookup = {
    lookupReturnType(callee: string): string | undefined {
      if (!symbolTable) return undefined;
      if (isBuiltInOrNoise(callee)) return undefined;
      const callables = symbolTable.lookupFuzzyCallable(callee);
      if (callables.length !== 1) return undefined;
      const rawReturn = callables[0].returnType;
      if (!rawReturn) return undefined;
      return extractReturnTypeName(rawReturn);
    },
    lookupRawReturnType(callee: string): string | undefined {
      if (!symbolTable) return undefined;
      if (isBuiltInOrNoise(callee)) return undefined;
      const callables = symbolTable.lookupFuzzyCallable(callee);
      if (callables.length !== 1) return undefined;
      return callables[0].returnType;
    }
  };

  // Pre-compute combined set of node types that need extractTypeBinding.
  // Single Set.has() replaces 3 separate checks per node in walk().
  const interestingNodeTypes = new Set<string>();
  TYPED_PARAMETER_TYPES.forEach(t => interestingNodeTypes.add(t));
  config.declarationNodeTypes.forEach(t => interestingNodeTypes.add(t));
  config.forLoopNodeTypes?.forEach(t => interestingNodeTypes.add(t));
  // Tier 2: copy-propagation (`const b = a`) and call-result propagation (`const b = foo()`)
  const pendingCopies: Array<{ scope: string; lhs: string; rhs: string }> = [];
  // NOTE: Infrastructure-ready — no language extractor currently returns { kind: 'callResult' }
  // from extractPendingAssignment. When one does, this array will bind variables to their
  // function return types at TypeEnv build time. See PendingAssignment in types.ts.
  const pendingCallResults: Array<{ scope: string; lhs: string; callee: string }> = [];
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
  const extractTypeBinding = (node: SyntaxNode, scopeEnv: Map<string, string>, scope: string): void => {
    // This guard eliminates 90%+ of calls before any language dispatch.
    if (TYPED_PARAMETER_TYPES.has(node.type)) {
      // Capture the raw type annotation BEFORE extractParameter.
      // Most languages use 'name' field; Rust uses 'pattern'; TS uses 'pattern' for some param types.
      // Kotlin `parameter` nodes use positional children instead of named fields,
      // so we fall back to scanning children by type when childForFieldName returns null.
      let typeNode = node.childForFieldName('type');
      if (typeNode) {
        const nameNode = node.childForFieldName('name')
          ?? node.childForFieldName('pattern')
          // Python typed_parameter: name is a positional child (identifier), not a named field
          ?? (node.firstNamedChild?.type === 'identifier' ? node.firstNamedChild : null);
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
          if (!fallbackName && (child.type === 'simple_identifier' || child.type === 'identifier')) {
            fallbackName = child;
          }
          if (!fallbackType && (child.type === 'user_type' || child.type === 'type_identifier'
            || child.type === 'generic_type' || child.type === 'parameterized_type')) {
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
        const forLoopCtx: ForLoopExtractorContext = { scopeEnv, declarationTypeNodes, scope, returnTypeLookup };
        config.extractForLoopBinding(node, forLoopCtx);
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
            if (c?.type === 'variable_declaration') { wrapped = c; break; }
          }
        }
        if (wrapped) typeNode = wrapped.childForFieldName('type');
      }
      if (typeNode) {
        const nameNode = node.childForFieldName('name')
          ?? node.childForFieldName('left')
          ?? node.childForFieldName('pattern');
        if (nameNode) {
          const varName = extractVarName(nameNode);
          if (varName && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
            declarationTypeNodes.set(`${scope}\0${varName}`, typeNode);
          }
        }
      }
      // Run the language-specific declaration extractor (may or may not add to scopeEnv).
      const keysBefore = typeNode ? new Set(scopeEnv.keys()) : undefined;
      config.extractDeclaration(node, scopeEnv);
      // Fallback: for multi-declarator languages (TS, C#, Java) where the type field
      // is on variable_declarator children, capture via keysBefore/keysAfter diff.
      if (typeNode && keysBefore) {
        for (const varName of scopeEnv.keys()) {
          if (!keysBefore.has(varName) && !declarationTypeNodes.has(`${scope}\0${varName}`)) {
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

    // Only create scope map and call extractTypeBinding for interesting node types.
    // Single Set.has() replaces 3 separate checks inside extractTypeBinding.
    if (interestingNodeTypes.has(node.type)) {
      if (!env.has(scope)) env.set(scope, new Map());
      const scopeEnv = env.get(scope)!;
      extractTypeBinding(node, scopeEnv, scope);
    }

    // Pattern binding extraction: handles constructs that introduce NEW typed variables
    // via pattern matching (e.g. `if let Some(x) = opt`, `x instanceof T t`).
    // Runs after Tier 0/1 so scopeEnv already contains the source variable's type.
    // Conservative: extractor returns undefined when source type is unknown.
    if (config.extractPatternBinding && (!config.patternBindingNodeTypes || config.patternBindingNodeTypes.has(node.type))) {
      // Ensure scopeEnv exists for pattern binding reads/writes
      if (!env.has(scope)) env.set(scope, new Map());
      const scopeEnv = env.get(scope)!;
      const patternBinding = config.extractPatternBinding(node, scopeEnv, declarationTypeNodes, scope);
      if (patternBinding) {
        if (config.allowPatternBindingOverwrite) {
          // Position-indexed: store per-branch binding for smart-cast narrowing.
          // Each when arm / switch case gets its own type for the variable,
          // preventing cross-arm contamination (e.g., Kotlin when/is).
          const branchNode = findPatternBranchScope(node);
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
    if (config.extractPendingAssignment && config.declarationNodeTypes.has(node.type)) {
      // scopeEnv is guaranteed to exist here because declarationNodeTypes is a subset
      // of interestingNodeTypes, so extractTypeBinding already created the scope map above.
      const scopeEnv = env.get(scope);
      if (scopeEnv) {
        const pending = config.extractPendingAssignment(node, scopeEnv);
        if (pending) {
          if (pending.kind === 'copy') {
            pendingCopies.push({ scope, lhs: pending.lhs, rhs: pending.rhs });
          } else {
            pendingCallResults.push({ scope, lhs: pending.lhs, callee: pending.callee });
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

  // Tier 2a: copy-propagation — `const b = a` where `a` has a known type from Tier 0/1.
  // Multi-hop chains resolve when forward-declared (a→b→c in source order);
  // reverse-order assignments are depth-1 only. No fixpoint iteration —
  // this covers 95%+ of real-world patterns.
  for (const { scope, lhs, rhs } of pendingCopies) {
    const scopeEnv = env.get(scope);
    if (!scopeEnv || scopeEnv.has(lhs)) continue;
    const rhsType = scopeEnv.get(rhs) ?? env.get(FILE_SCOPE)?.get(rhs);
    if (rhsType) scopeEnv.set(lhs, rhsType);
  }

  // Tier 2b: call-result propagation — `const b = foo()` where `foo` has a declared return type.
  // Uses ReturnTypeLookup which is backed by SymbolTable.lookupFuzzyCallable.
  // Conservative: only binds when exactly one callable matches (avoids overload ambiguity).
  // NOTE: Currently dormant — no extractPendingAssignment implementation emits 'callResult' yet.
  // The loop is structurally complete and will activate when any language extractor starts
  // returning { kind: 'callResult', lhs, callee } from extractPendingAssignment.
  for (const { scope, lhs, callee } of pendingCallResults) {
    const scopeEnv = env.get(scope);
    if (!scopeEnv || scopeEnv.has(lhs)) continue;
    const typeName = returnTypeLookup.lookupReturnType(callee);
    if (typeName) scopeEnv.set(lhs, typeName);
  }

  return {
    lookup: (varName, callNode) => lookupInEnv(env, varName, callNode, patternOverrides),
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


