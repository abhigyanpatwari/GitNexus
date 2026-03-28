import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ClassNameLookup,
  ConstructorBindingScanner,
  PendingAssignmentExtractor,
  PendingAssignment,
  PatternBindingExtractor,
  ForLoopExtractor,
} from './types.js';
import {
  extractSimpleTypeName,
  extractVarName,
  hasTypeAnnotation,
  unwrapAwait,
  extractGenericTypeArgs,
  resolveIterableElementType,
  methodToTypeArgPosition,
  extractElementTypeFromString,
  type TypeArgPosition,
} from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set(['let_declaration', 'let_condition']);

/** Walk up the AST to find the enclosing impl block and extract the implementing type name. */
const findEnclosingImplType = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (current.type === 'impl_item') {
      // The 'type' field holds the implementing type (e.g., `impl User { ... }`)
      const typeNode = current.childForFieldName('type');
      if (typeNode) return extractSimpleTypeName(typeNode);
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Extract the type name from a struct_pattern's 'type' field.
 * Handles both simple `User { .. }` and scoped `Message::Data { .. }`.
 */
const extractStructPatternType = (structPattern: SyntaxNode): string | undefined => {
  const typeNode = structPattern.childForFieldName('type');
  if (!typeNode) return undefined;
  return extractSimpleTypeName(typeNode);
};

/**
 * Recursively scan a pattern tree for captured_pattern nodes (x @ StructType { .. })
 * and extract variable → type bindings from them.
 */
const extractCapturedPatternBindings = (
  pattern: SyntaxNode,
  env: Map<string, string>,
  depth = 0,
): void => {
  if (depth > 50) return;
  if (pattern.type === 'captured_pattern') {
    // captured_pattern: identifier @ inner_pattern
    // The first named child is the identifier, followed by the inner pattern.
    const nameNode = pattern.firstNamedChild;
    if (!nameNode || nameNode.type !== 'identifier') return;
    // Find the struct_pattern child — that gives us the type
    for (let i = 0; i < pattern.namedChildCount; i++) {
      const child = pattern.namedChild(i);
      if (child?.type === 'struct_pattern') {
        const typeName = extractStructPatternType(child);
        if (typeName) env.set(nameNode.text, typeName);
        return;
      }
    }
    return;
  }
  // Recurse into tuple_struct_pattern children to find nested captured_patterns
  // e.g., Some(user @ User { .. })
  if (pattern.type === 'tuple_struct_pattern') {
    for (let i = 0; i < pattern.namedChildCount; i++) {
      const child = pattern.namedChild(i);
      if (child) extractCapturedPatternBindings(child, env, depth + 1);
    }
  }
};

/** Rust: let x: Foo = ... | if let / while let pattern bindings */
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  if (node.type === 'let_condition') {
    // if let / while let: extract type bindings from pattern matching.
    //
    // Supported patterns:
    // - captured_pattern: `if let user @ User { .. } = expr` → user: User
    // - tuple_struct_pattern with nested captured_pattern:
    //   `if let Some(user @ User { .. }) = expr` → user: User
    //
    // NOT supported (requires generic unwrapping — Phase 3):
    // - `if let Some(x) = opt` where opt: Option<T> → x: T
    //
    // struct_pattern without capture (`if let User { name } = expr`)
    // destructures fields — individual field types are unknown without
    // field-type resolution, so no bindings are extracted.
    const pattern = node.childForFieldName('pattern');
    if (!pattern) return;
    extractCapturedPatternBindings(pattern, env);
    return;
  }

  // Standard let_declaration: let x: Foo = ...
  const pattern = node.childForFieldName('pattern');
  const typeNode = node.childForFieldName('type');
  if (!pattern || !typeNode) return;
  const varName = extractVarName(pattern);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Rust: let x = User::new(), let x = User::default(), or let x = User { ... } */
const extractInitializer: InitializerExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
  classNames: ClassNameLookup,
): void => {
  // Skip if there's an explicit type annotation — Tier 0 already handled it
  if (node.childForFieldName('type') !== null) return;
  const pattern = node.childForFieldName('pattern');
  const value = node.childForFieldName('value');
  if (!pattern || !value) return;

  // Rust struct literal: let user = User { name: "alice", age: 30 }
  // tree-sitter-rust: struct_expression with 'name' field holding the type
  if (value.type === 'struct_expression') {
    const typeNode = value.childForFieldName('name');
    if (!typeNode) return;
    const rawType = extractSimpleTypeName(typeNode);
    if (!rawType) return;
    // Resolve Self to the actual struct/enum name from the enclosing impl block
    const typeName = rawType === 'Self' ? findEnclosingImplType(node) : rawType;
    const varName = extractVarName(pattern);
    if (varName && typeName) env.set(varName, typeName);
    return;
  }

  // Unit struct instantiation: let svc = UserService; (bare identifier, no braces or call)
  if (value.type === 'identifier' && classNames.has(value.text)) {
    const varName = extractVarName(pattern);
    if (varName) env.set(varName, value.text);
    return;
  }

  if (value.type !== 'call_expression') return;
  const func = value.childForFieldName('function');
  if (!func || func.type !== 'scoped_identifier') return;
  const nameField = func.childForFieldName('name');
  // Only match ::new() and ::default() — the two idiomatic Rust constructors.
  // Deliberately excludes ::from(), ::with_capacity(), etc. to avoid false positives
  // (e.g. String::from("x") is not necessarily the "String" type we want for method resolution).
  if (!nameField || (nameField.text !== 'new' && nameField.text !== 'default')) return;
  const pathField = func.childForFieldName('path');
  if (!pathField) return;
  const rawType = extractSimpleTypeName(pathField);
  if (!rawType) return;
  // Resolve Self to the actual struct/enum name from the enclosing impl block
  const typeName = rawType === 'Self' ? findEnclosingImplType(node) : rawType;
  const varName = extractVarName(pattern);
  if (varName && typeName) env.set(varName, typeName);
};

/** Rust: parameter → pattern: type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('pattern');
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

/** Rust: let user = get_user("alice") — let_declaration with call_expression value, no type annotation.
 * Skips `let user: User = ...` (explicit type annotation — handled by extractDeclaration).
 * Skips `let user = User::new()` (scoped_identifier callee named "new" — handled by extractInitializer).
 * Unwraps `let mut user = get_user()` by looking inside mut_pattern for the inner identifier.
 */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'let_declaration') return undefined;
  if (hasTypeAnnotation(node)) return undefined;
  let patternNode = node.childForFieldName('pattern');
  if (!patternNode) return undefined;
  if (patternNode.type === 'mut_pattern') {
    patternNode = patternNode.firstNamedChild;
    if (!patternNode) return undefined;
  }
  if (patternNode.type !== 'identifier') return undefined;
  // Unwrap `.await`: `let user = get_user().await` → await_expression wraps call_expression
  const value = unwrapAwait(node.childForFieldName('value'));
  if (!value || value.type !== 'call_expression') return undefined;
  const func = value.childForFieldName('function');
  if (!func) return undefined;
  if (func.type === 'scoped_identifier') {
    const methodName = func.lastNamedChild;
    if (methodName?.text === 'new' || methodName?.text === 'default') return undefined;
  }
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: patternNode.text, calleeName };
};

/** Rust: let alias = u; → let_declaration with pattern + value fields.
 *  Also handles struct destructuring: `let Point { x, y } = p` → N fieldAccess items. */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type !== 'let_declaration') return undefined;
  const pattern = node.childForFieldName('pattern');
  const value = node.childForFieldName('value');
  if (!pattern || !value) return undefined;

  // Struct pattern destructuring: `let Point { x, y } = receiver`
  // struct_pattern has a type child (struct name) and field_pattern children
  if (pattern.type === 'struct_pattern' && value.type === 'identifier') {
    const receiver = value.text;
    const items: PendingAssignment[] = [];
    for (let j = 0; j < pattern.namedChildCount; j++) {
      const field = pattern.namedChild(j);
      if (!field) continue;
      if (field.type === 'field_pattern') {
        // `Point { x: local_x }` → field_pattern with name + pattern children
        const nameNode = field.childForFieldName('name');
        const patNode = field.childForFieldName('pattern');
        if (nameNode && patNode) {
          const fieldName = nameNode.text;
          const varName = extractVarName(patNode);
          if (varName && !scopeEnv.has(varName)) {
            items.push({ kind: 'fieldAccess', lhs: varName, receiver, field: fieldName });
          }
        } else if (nameNode) {
          // Shorthand: `Point { x }` → field_pattern with only name (varName = fieldName)
          const varName = nameNode.text;
          if (!scopeEnv.has(varName)) {
            items.push({ kind: 'fieldAccess', lhs: varName, receiver, field: varName });
          }
        }
      }
    }
    if (items.length > 0) return items;
    return undefined;
  }

  const lhs = extractVarName(pattern);
  if (!lhs || scopeEnv.has(lhs)) return undefined;
  // Unwrap Rust .await: `let user = get_user().await` → call_expression
  const unwrapped = unwrapAwait(value) ?? value;
  if (unwrapped.type === 'identifier') return { kind: 'copy', lhs, rhs: unwrapped.text };
  // field_expression RHS → fieldAccess (a.field)
  if (unwrapped.type === 'field_expression') {
    const obj = unwrapped.firstNamedChild;
    const field = unwrapped.lastNamedChild;
    if (obj?.type === 'identifier' && field?.type === 'field_identifier') {
      return { kind: 'fieldAccess', lhs, receiver: obj.text, field: field.text };
    }
  }
  // call_expression RHS → callResult (simple calls only)
  if (unwrapped.type === 'call_expression') {
    const funcNode = unwrapped.childForFieldName('function');
    if (funcNode?.type === 'identifier') {
      return { kind: 'callResult', lhs, callee: funcNode.text };
    }
  }
  // method_call_expression RHS → methodCallResult (receiver.method())
  if (unwrapped.type === 'method_call_expression') {
    const obj = unwrapped.firstNamedChild;
    if (obj?.type === 'identifier') {
      const methodNode = unwrapped.childForFieldName('name') ?? unwrapped.namedChild(1);
      if (methodNode?.type === 'field_identifier') {
        return { kind: 'methodCallResult', lhs, receiver: obj.text, method: methodNode.text };
      }
    }
  }
  return undefined;
};

/**
 * Rust pattern binding extractor for `if let` / `while let` constructs that unwrap
 * enum variants and introduce new typed variables.
 *
 * Supported patterns:
 * - `if let Some(x) = opt`  → x: T  (opt: Option<T>, T already in scopeEnv via NULLABLE_WRAPPER_TYPES)
 * - `if let Ok(x) = res`    → x: T  (res: Result<T, E>, T extracted from declarationTypeNodes)
 *
 * These complement the captured_pattern support in extractDeclaration (which handles
 * `if let x @ Struct { .. } = expr` but NOT tuple struct unwrapping like Some(x) / Ok(x)).
 *
 * Conservative: returns undefined when:
 * - The source variable's type is unknown (not in scopeEnv)
 * - The wrapper is not a known single-unwrap variant (Some / Ok)
 * - The value side is not a simple identifier
 */
const extractPatternBinding: PatternBindingExtractor = (
  node,
  scopeEnv,
  declarationTypeNodes,
  scope,
) => {
  let patternNode: SyntaxNode | null = null;
  let valueNode: SyntaxNode | null = null;

  if (node.type === 'let_condition') {
    patternNode = node.childForFieldName('pattern');
    valueNode = node.childForFieldName('value');
  } else if (node.type === 'match_arm') {
    // match_arm → pattern field is match_pattern wrapping the actual pattern
    const matchPatternNode = node.childForFieldName('pattern');
    // Unwrap match_pattern to get the tuple_struct_pattern inside
    patternNode =
      matchPatternNode?.type === 'match_pattern'
        ? matchPatternNode.firstNamedChild
        : matchPatternNode;
    // source variable is in the parent match_expression's 'value' field
    const matchExpr = node.parent?.parent; // match_arm → match_block → match_expression
    if (matchExpr?.type === 'match_expression') {
      valueNode = matchExpr.childForFieldName('value');
    }
  }
  if (!patternNode || !valueNode) return undefined;

  // Only handle tuple_struct_pattern: Some(x) or Ok(x)
  if (patternNode.type !== 'tuple_struct_pattern') return undefined;

  // Extract the wrapper type name: Some | Ok
  const wrapperTypeNode = patternNode.childForFieldName('type');
  if (!wrapperTypeNode) return undefined;
  const wrapperName = extractSimpleTypeName(wrapperTypeNode);
  if (wrapperName !== 'Some' && wrapperName !== 'Ok' && wrapperName !== 'Err') return undefined;

  // Extract the inner variable name from the single child of the tuple_struct_pattern.
  // `Some(x)` → the first named child after the type field is the identifier.
  // tree-sitter-rust: tuple_struct_pattern has 'type' field + unnamed children for args.
  let innerVar: string | undefined;
  for (let i = 0; i < patternNode.namedChildCount; i++) {
    const child = patternNode.namedChild(i);
    if (!child) continue;
    // Skip the type node itself
    if (child === wrapperTypeNode) continue;
    if (child.type === 'identifier') {
      innerVar = child.text;
      break;
    }
  }
  if (!innerVar) return undefined;

  // The value must be a simple identifier so we can look it up in scopeEnv
  const sourceVarName = valueNode.type === 'identifier' ? valueNode.text : undefined;
  if (!sourceVarName) return undefined;

  // For `Some(x)`: Option<T> is already unwrapped to T in scopeEnv (via NULLABLE_WRAPPER_TYPES).
  // For `Ok(x)`: Result<T, E> stores "Result" in scopeEnv — must use declarationTypeNodes.
  if (wrapperName === 'Some') {
    const innerType = scopeEnv.get(sourceVarName);
    if (!innerType) return undefined;
    return { varName: innerVar, typeName: innerType };
  }

  // wrapperName === 'Ok' or 'Err': look up the Result<T, E> type AST node.
  // Ok(x) → extract T (typeArgs[0]), Err(e) → extract E (typeArgs[1]).
  const typeNodeKey = `${scope}\0${sourceVarName}`;
  const typeAstNode = declarationTypeNodes.get(typeNodeKey);
  if (!typeAstNode) return undefined;
  const typeArgs = extractGenericTypeArgs(typeAstNode);
  const argIndex = wrapperName === 'Err' ? 1 : 0;
  if (typeArgs.length < argIndex + 1) return undefined;
  return { varName: innerVar, typeName: typeArgs[argIndex] };
};

// --- For-loop Tier 1c ---

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['for_expression']);

/** Extract element type from a Rust type annotation AST node.
 *  Handles: generic_type (Vec<User>), reference_type (&[User]), array_type ([User; N]),
 *  slice_type ([User]). For call-graph purposes, strips references (&User → User). */
const extractRustElementTypeFromTypeNode = (
  typeNode: SyntaxNode,
  pos: TypeArgPosition = 'last',
  depth = 0,
): string | undefined => {
  if (depth > 50) return undefined;
  // generic_type: Vec<User>, HashMap<K, V> — extract type arg based on position
  if (typeNode.type === 'generic_type') {
    const args = extractGenericTypeArgs(typeNode);
    if (args.length >= 1) return pos === 'first' ? args[0] : args[args.length - 1];
  }
  // reference_type: &[User] or &Vec<User> — unwrap the reference and recurse
  if (typeNode.type === 'reference_type') {
    const inner = typeNode.lastNamedChild;
    if (inner) return extractRustElementTypeFromTypeNode(inner, pos, depth + 1);
  }
  // array_type: [User; N] — element is the first child
  if (typeNode.type === 'array_type') {
    const elemNode = typeNode.firstNamedChild;
    if (elemNode) return extractSimpleTypeName(elemNode);
  }
  // slice_type: [User] — element is the first child
  if (typeNode.type === 'slice_type') {
    const elemNode = typeNode.firstNamedChild;
    if (elemNode) return extractSimpleTypeName(elemNode);
  }
  return undefined;
};

/** Walk up from a for-loop to the enclosing function_item and search parameters
 *  for one named `iterableName`. Returns the element type from its annotation. */
const findRustParamElementType = (
  iterableName: string,
  startNode: SyntaxNode,
  pos: TypeArgPosition = 'last',
): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  while (current) {
    if (current.type === 'function_item') {
      const paramsNode = current.childForFieldName('parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const param = paramsNode.namedChild(i);
          if (!param || param.type !== 'parameter') continue;
          const nameNode = param.childForFieldName('pattern');
          if (!nameNode) continue;
          // Unwrap reference patterns: &users, &mut users
          let identNode = nameNode;
          if (identNode.type === 'reference_pattern') {
            identNode = identNode.lastNamedChild ?? identNode;
          }
          if (identNode.type === 'mut_pattern') {
            identNode = identNode.firstNamedChild ?? identNode;
          }
          if (identNode.text !== iterableName) continue;
          const typeNode = param.childForFieldName('type');
          if (typeNode) return extractRustElementTypeFromTypeNode(typeNode, pos);
        }
      }
      break;
    }
    current = current.parent;
  }
  return undefined;
};

/** Rust: for user in &users where users has a known container type.
 *  Unwraps reference_expression (&users, &mut users) to get the iterable name. */
const extractForLoopBinding: ForLoopExtractor = (
  node,
  { scopeEnv, declarationTypeNodes, scope, returnTypeLookup },
): void => {
  if (node.type !== 'for_expression') return;

  const patternNode = node.childForFieldName('pattern');
  const valueNode = node.childForFieldName('value');
  if (!patternNode || !valueNode) return;

  // Extract iterable name + method — may be &users, users, or users.iter()/keys()/values()
  let iterableName: string | undefined;
  let methodName: string | undefined;
  let callExprElementType: string | undefined;
  if (valueNode.type === 'reference_expression') {
    const inner = valueNode.lastNamedChild;
    if (inner?.type === 'identifier') iterableName = inner.text;
  } else if (valueNode.type === 'identifier') {
    iterableName = valueNode.text;
  } else if (valueNode.type === 'field_expression') {
    const prop = valueNode.lastNamedChild;
    if (prop) iterableName = prop.text;
  } else if (valueNode.type === 'call_expression') {
    const funcExpr = valueNode.childForFieldName('function');
    if (funcExpr?.type === 'field_expression') {
      // users.iter() → field_expression > identifier + field_identifier
      const obj = funcExpr.firstNamedChild;
      if (obj?.type === 'identifier') iterableName = obj.text;
      // Extract method name: iter, keys, values, into_iter, etc.
      const field = funcExpr.lastNamedChild;
      if (field?.type === 'field_identifier') methodName = field.text;
    } else if (funcExpr?.type === 'identifier') {
      // Direct function call: for user in get_users()
      const rawReturn = returnTypeLookup.lookupRawReturnType(funcExpr.text);
      if (rawReturn) callExprElementType = extractElementTypeFromString(rawReturn);
    }
  }
  if (!iterableName && !callExprElementType) return;

  let elementType: string | undefined;
  if (callExprElementType) {
    elementType = callExprElementType;
  } else {
    const containerTypeName = scopeEnv.get(iterableName!);
    const typeArgPos = methodToTypeArgPosition(methodName, containerTypeName);
    elementType = resolveIterableElementType(
      iterableName!,
      node,
      scopeEnv,
      declarationTypeNodes,
      scope,
      extractRustElementTypeFromTypeNode,
      findRustParamElementType,
      typeArgPos,
    );
  }
  if (!elementType) return;

  const loopVarName = extractVarName(patternNode);
  if (loopVarName) scopeEnv.set(loopVarName, elementType);
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  patternBindingNodeTypes: new Set(['let_condition', 'match_arm']),
  extractDeclaration,
  extractInitializer,
  extractParameter,
  scanConstructorBinding,
  extractForLoopBinding,
  extractPendingAssignment,
  extractPatternBinding,
};
