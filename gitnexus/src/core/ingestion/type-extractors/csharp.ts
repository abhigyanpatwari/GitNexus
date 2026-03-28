import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type {
  ConstructorBindingScanner,
  ForLoopExtractor,
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  PendingAssignmentExtractor,
  PatternBindingExtractor,
  LiteralTypeInferrer,
} from './types.js';
import {
  extractSimpleTypeName,
  extractVarName,
  unwrapAwait,
  resolveIterableElementType,
  methodToTypeArgPosition,
  extractElementTypeFromString,
  type TypeArgPosition,
} from './shared.js';

/** Known container property accessors that operate on the container itself (e.g., dict.Keys, dict.Values) */
const KNOWN_CONTAINER_PROPS: ReadonlySet<string> = new Set(['Keys', 'Values']);

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'local_declaration_statement',
  'variable_declaration',
  'field_declaration',
]);

/** C#: Type x = ...; var x = new Type(); */
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  // C# tree-sitter: local_declaration_statement > variable_declaration > ...
  // Recursively descend through wrapper nodes
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'variable_declaration' || child.type === 'local_declaration_statement') {
      extractDeclaration(child, env);
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
    // tree-sitter-c-sharp may put object_creation_expression as direct child
    // or inside equals_value_clause depending on grammar version
    if (declarators.length === 1) {
      const initializer =
        findChild(declarators[0], 'object_creation_expression') ??
        findChild(declarators[0], 'equals_value_clause')?.firstNamedChild;
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

/** C#: parameter → type name */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
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

/** C#: var x = SomeFactory(...) → bind x to SomeFactory (constructor-like call) */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'variable_declaration') return undefined;
  // Find type and declarator children by iterating (C# grammar doesn't expose 'type' as a named field)
  let typeNode: SyntaxNode | null = null;
  let declarator: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'variable_declarator') {
      if (!declarator) declarator = child;
    } else if (!typeNode) {
      typeNode = child;
    }
  }
  // Only handle implicit_type (var) — explicit types handled by extractDeclaration
  if (!typeNode || typeNode.type !== 'implicit_type') return undefined;
  if (!declarator) return undefined;
  const nameNode = declarator.childForFieldName('name') ?? declarator.firstNamedChild;
  if (!nameNode || nameNode.type !== 'identifier') return undefined;
  // Find the initializer value: either inside equals_value_clause or as a direct child
  // (tree-sitter-c-sharp puts invocation_expression directly inside variable_declarator)
  let value: SyntaxNode | null = null;
  for (let i = 0; i < declarator.namedChildCount; i++) {
    const child = declarator.namedChild(i);
    if (!child) continue;
    if (child.type === 'equals_value_clause') {
      value = child.firstNamedChild;
      break;
    }
    if (
      child.type === 'invocation_expression' ||
      child.type === 'object_creation_expression' ||
      child.type === 'await_expression'
    ) {
      value = child;
      break;
    }
  }
  if (!value) return undefined;
  // Unwrap await: `var user = await svc.GetUserAsync()` → await_expression wraps invocation_expression
  value = unwrapAwait(value);
  if (!value) return undefined;
  // Skip object_creation_expression (new User()) — handled by extractInitializer
  if (value.type === 'object_creation_expression') return undefined;
  if (value.type !== 'invocation_expression') return undefined;
  const func = value.firstNamedChild;
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
};

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['foreach_statement']);

/** Extract element type from a C# type annotation AST node.
 *  Handles generic_name (List<User>), array_type (User[]), nullable_type (?).
 *  `pos` selects which type arg: 'first' for keys, 'last' for values (default). */
const extractCSharpElementTypeFromTypeNode = (
  typeNode: SyntaxNode,
  pos: TypeArgPosition = 'last',
  depth = 0,
): string | undefined => {
  if (depth > 50) return undefined;
  // generic_name: List<User>, IEnumerable<User>, Dictionary<string, User>
  // C# uses generic_name (not generic_type)
  if (typeNode.type === 'generic_name') {
    const argList = findChild(typeNode, 'type_argument_list');
    if (argList && argList.namedChildCount >= 1) {
      if (pos === 'first') {
        const firstArg = argList.namedChild(0);
        if (firstArg) return extractSimpleTypeName(firstArg);
      } else {
        const lastArg = argList.namedChild(argList.namedChildCount - 1);
        if (lastArg) return extractSimpleTypeName(lastArg);
      }
    }
  }
  // array_type: User[]
  if (typeNode.type === 'array_type') {
    const elemNode = typeNode.firstNamedChild;
    if (elemNode) return extractSimpleTypeName(elemNode);
  }
  // nullable_type: unwrap and recurse (List<User>? → List<User> → User)
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractCSharpElementTypeFromTypeNode(inner, pos, depth + 1);
  }
  return undefined;
};

/** Walk up from a foreach to the enclosing method and search parameters. */
const findCSharpParamElementType = (
  iterableName: string,
  startNode: SyntaxNode,
  pos: TypeArgPosition = 'last',
): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  while (current) {
    if (current.type === 'method_declaration' || current.type === 'local_function_statement') {
      const paramsNode = current.childForFieldName('parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const param = paramsNode.namedChild(i);
          if (!param || param.type !== 'parameter') continue;
          const nameNode = param.childForFieldName('name');
          if (nameNode?.text !== iterableName) continue;
          const typeNode = param.childForFieldName('type');
          if (typeNode) return extractCSharpElementTypeFromTypeNode(typeNode, pos);
        }
      }
      break;
    }
    current = current.parent;
  }
  return undefined;
};

/** C#: foreach (User user in users) — extract loop variable binding.
 *  Tier 1c: for `foreach (var user in users)`, resolves element type from iterable. */
const extractForLoopBinding: ForLoopExtractor = (
  node,
  { scopeEnv, declarationTypeNodes, scope, returnTypeLookup },
): void => {
  const typeNode = node.childForFieldName('type');
  const nameNode = node.childForFieldName('left');
  if (!typeNode || !nameNode) return;
  const varName = extractVarName(nameNode);
  if (!varName) return;

  // Explicit type (existing behavior): foreach (User user in users)
  if (!(typeNode.type === 'implicit_type' && typeNode.text === 'var')) {
    const typeName = extractSimpleTypeName(typeNode);
    if (typeName) scopeEnv.set(varName, typeName);
    return;
  }

  // Tier 1c: implicit type (var) — resolve from iterable's container type
  const rightNode = node.childForFieldName('right');
  let iterableName: string | undefined;
  let methodName: string | undefined;
  let callExprElementType: string | undefined;

  if (rightNode?.type === 'identifier') {
    iterableName = rightNode.text;
  } else if (rightNode?.type === 'member_access_expression') {
    // C# property access: data.Keys, data.Values → member_access_expression
    // Also handles bare member access: this.users, repo.users → use property as iterableName
    const obj = rightNode.childForFieldName('expression');
    const prop = rightNode.childForFieldName('name');
    const propText = prop?.type === 'identifier' ? prop.text : undefined;
    if (propText && KNOWN_CONTAINER_PROPS.has(propText)) {
      if (obj?.type === 'identifier') {
        iterableName = obj.text;
      } else if (obj?.type === 'member_access_expression') {
        // Nested member access: this.data.Values → obj is "this.data", extract "data"
        const innerProp = obj.childForFieldName('name');
        if (innerProp) iterableName = innerProp.text;
      }
      methodName = propText;
    } else if (propText) {
      // Bare member access: this.users → use property name for scopeEnv lookup
      iterableName = propText;
    }
  } else if (rightNode?.type === 'invocation_expression') {
    // C# method call: data.Select(...) → invocation_expression > member_access_expression
    // Direct function call: GetUsers() → invocation_expression > identifier
    const fn = rightNode.firstNamedChild;
    if (fn?.type === 'member_access_expression') {
      const obj = fn.childForFieldName('expression');
      const prop = fn.childForFieldName('name');
      if (obj?.type === 'identifier') iterableName = obj.text;
      if (prop?.type === 'identifier') methodName = prop.text;
    } else if (fn?.type === 'identifier') {
      // Direct function call: foreach (var u in GetUsers())
      const rawReturn = returnTypeLookup.lookupRawReturnType(fn.text);
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
      extractCSharpElementTypeFromTypeNode,
      findCSharpParamElementType,
      typeArgPos,
    );
  }
  if (elementType) scopeEnv.set(varName, elementType);
};

/**
 * C# pattern binding extractor for `obj is Type variable` (type pattern).
 *
 * AST structure:
 *   is_pattern_expression
 *     expression: (the variable being tested)
 *     pattern: declaration_pattern
 *       type: (the declared type)
 *       name: single_variable_designation > identifier (the new variable name)
 *
 * Conservative: returns undefined when the pattern field is absent, is not a
 * declaration_pattern, or when the type/name cannot be extracted.
 * No scopeEnv lookup is needed — the pattern explicitly declares the new variable's type.
 */
/**
 * Find the if-body (consequence) block for a C# null-check.
 * Walks up from the expression to find the enclosing if_statement,
 * then returns its first block child (the truthy branch body).
 */
const findCSharpIfConsequenceBlock = (expr: SyntaxNode): SyntaxNode | undefined => {
  let current = expr.parent;
  while (current) {
    if (current.type === 'if_statement') {
      // C# if_statement consequence is the 'consequence' field or first block child
      const consequence = current.childForFieldName('consequence');
      if (consequence) return consequence;
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child?.type === 'block') return child;
      }
      return undefined;
    }
    if (
      current.type === 'block' ||
      current.type === 'method_declaration' ||
      current.type === 'constructor_declaration' ||
      current.type === 'local_function_statement' ||
      current.type === 'lambda_expression'
    )
      return undefined;
    current = current.parent;
  }
  return undefined;
};

/** Check if a C# declaration type node represents a nullable type.
 *  Checks for nullable_type AST node or '?' in the type text (e.g., User?). */
const isCSharpNullableDecl = (declTypeNode: SyntaxNode): boolean => {
  if (declTypeNode.type === 'nullable_type') return true;
  return declTypeNode.text.includes('?');
};

const extractPatternBinding: PatternBindingExtractor = (
  node,
  scopeEnv,
  declarationTypeNodes,
  scope,
) => {
  // is_pattern_expression: `obj is User user` — has a declaration_pattern child
  // Also handles `x is not null` for null-check narrowing
  if (node.type === 'is_pattern_expression') {
    const pattern = node.childForFieldName('pattern');
    if (!pattern) return undefined;

    // Standard type pattern: `obj is User user`
    if (pattern.type === 'declaration_pattern' || pattern.type === 'recursive_pattern') {
      const typeNode = pattern.childForFieldName('type');
      const nameNode = pattern.childForFieldName('name');
      if (!typeNode || !nameNode) return undefined;
      const typeName = extractSimpleTypeName(typeNode);
      const varName = extractVarName(nameNode);
      if (!typeName || !varName) return undefined;
      return { varName, typeName };
    }

    // Null-check: `x is not null` — negated_pattern > constant_pattern > null_literal
    if (pattern.type === 'negated_pattern') {
      const inner = pattern.firstNamedChild;
      if (inner?.type === 'constant_pattern') {
        const literal = inner.firstNamedChild ?? inner.firstChild;
        if (literal?.type === 'null_literal' || literal?.text === 'null') {
          const expr = node.childForFieldName('expression');
          if (!expr || expr.type !== 'identifier') return undefined;
          const varName = expr.text;
          const resolvedType = scopeEnv.get(varName);
          if (!resolvedType) return undefined;
          // Verify the original declaration was nullable
          const declTypeNode = declarationTypeNodes.get(`${scope}\0${varName}`);
          if (!declTypeNode || !isCSharpNullableDecl(declTypeNode)) return undefined;
          const ifBody = findCSharpIfConsequenceBlock(node);
          if (!ifBody) return undefined;
          return {
            varName,
            typeName: resolvedType,
            narrowingRange: { startIndex: ifBody.startIndex, endIndex: ifBody.endIndex },
          };
        }
      }
    }
    return undefined;
  }
  // declaration_pattern / recursive_pattern: standalone in switch statements and switch expressions
  // `case User u:` or `User u =>` or `User { Name: "Alice" } u =>`
  // Both use the same 'type' and 'name' fields.
  if (node.type === 'declaration_pattern' || node.type === 'recursive_pattern') {
    const typeNode = node.childForFieldName('type');
    const nameNode = node.childForFieldName('name');
    if (!typeNode || !nameNode) return undefined;
    const typeName = extractSimpleTypeName(typeNode);
    const varName = extractVarName(nameNode);
    if (!typeName || !varName) return undefined;
    return { varName, typeName };
  }
  // Null-check: `x != null` — binary_expression with != operator
  if (node.type === 'binary_expression') {
    const op = node.children.find((c) => !c.isNamed && c.text === '!=');
    if (!op) return undefined;
    const left = node.namedChild(0);
    const right = node.namedChild(1);
    if (!left || !right) return undefined;
    let varNode: SyntaxNode | undefined;
    if (left.type === 'identifier' && (right.type === 'null_literal' || right.text === 'null')) {
      varNode = left;
    } else if (
      right.type === 'identifier' &&
      (left.type === 'null_literal' || left.text === 'null')
    ) {
      varNode = right;
    }
    if (!varNode) return undefined;
    const varName = varNode.text;
    const resolvedType = scopeEnv.get(varName);
    if (!resolvedType) return undefined;
    // Verify the original declaration was nullable
    const declTypeNode = declarationTypeNodes.get(`${scope}\0${varName}`);
    if (!declTypeNode || !isCSharpNullableDecl(declTypeNode)) return undefined;
    const ifBody = findCSharpIfConsequenceBlock(node);
    if (!ifBody) return undefined;
    return {
      varName,
      typeName: resolvedType,
      narrowingRange: { startIndex: ifBody.startIndex, endIndex: ifBody.endIndex },
    };
  }
  return undefined;
};

/** C#: var alias = u → variable_declarator with name + equals_value_clause.
 *  Only local_declaration_statement and variable_declaration contain variable_declarator children;
 *  is_pattern_expression and field_declaration never do — skip them early. */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type === 'is_pattern_expression' || node.type === 'field_declaration') return undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    if (!nameNode) continue;
    const lhs = nameNode.text;
    if (scopeEnv.has(lhs)) continue;
    // C# wraps value in equals_value_clause; fall back to last named child
    let evc: SyntaxNode | null = null;
    for (let j = 0; j < child.childCount; j++) {
      if (child.child(j)?.type === 'equals_value_clause') {
        evc = child.child(j);
        break;
      }
    }
    const valueNode = evc?.firstNamedChild ?? child.namedChild(child.namedChildCount - 1);
    if (
      valueNode &&
      valueNode !== nameNode &&
      (valueNode.type === 'identifier' || valueNode.type === 'simple_identifier')
    ) {
      return { kind: 'copy', lhs, rhs: valueNode.text };
    }
    // member_access_expression RHS → fieldAccess (a.Field)
    if (valueNode?.type === 'member_access_expression') {
      const expr = valueNode.childForFieldName('expression');
      const name = valueNode.childForFieldName('name');
      if (expr?.type === 'identifier' && name?.type === 'identifier') {
        return { kind: 'fieldAccess', lhs, receiver: expr.text, field: name.text };
      }
    }
    // invocation_expression RHS
    if (valueNode?.type === 'invocation_expression') {
      const funcNode = valueNode.firstNamedChild;
      if (funcNode?.type === 'identifier_name' || funcNode?.type === 'identifier') {
        return { kind: 'callResult', lhs, callee: funcNode.text };
      }
      // method call with receiver → methodCallResult: a.GetC()
      if (funcNode?.type === 'member_access_expression') {
        const expr = funcNode.childForFieldName('expression');
        const name = funcNode.childForFieldName('name');
        if (expr?.type === 'identifier' && name?.type === 'identifier') {
          return { kind: 'methodCallResult', lhs, receiver: expr.text, method: name.text };
        }
      }
    }
    // await_expression → unwrap and check inner
    if (valueNode?.type === 'await_expression') {
      const inner = valueNode.firstNamedChild;
      if (inner?.type === 'invocation_expression') {
        const funcNode = inner.firstNamedChild;
        if (funcNode?.type === 'identifier_name' || funcNode?.type === 'identifier') {
          return { kind: 'callResult', lhs, callee: funcNode.text };
        }
        if (funcNode?.type === 'member_access_expression') {
          const expr = funcNode.childForFieldName('expression');
          const name = funcNode.childForFieldName('name');
          if (expr?.type === 'identifier' && name?.type === 'identifier') {
            return { kind: 'methodCallResult', lhs, receiver: expr.text, method: name.text };
          }
        }
      }
    }
  }
  return undefined;
};

/** Infer the type of a literal AST node for C# overload disambiguation. */
const inferLiteralType: LiteralTypeInferrer = (node) => {
  switch (node.type) {
    case 'integer_literal':
      if (node.text.endsWith('L') || node.text.endsWith('l')) return 'long';
      return 'int';
    case 'real_literal':
      if (node.text.endsWith('f') || node.text.endsWith('F')) return 'float';
      if (node.text.endsWith('m') || node.text.endsWith('M')) return 'decimal';
      return 'double';
    case 'string_literal':
    case 'verbatim_string_literal':
    case 'raw_string_literal':
    case 'interpolated_string_expression':
      return 'string';
    case 'character_literal':
      return 'char';
    case 'boolean_literal':
      return 'bool';
    case 'null_literal':
      return 'null';
    default:
      return undefined;
  }
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  patternBindingNodeTypes: new Set([
    'is_pattern_expression',
    'declaration_pattern',
    'recursive_pattern',
    'binary_expression',
  ]),
  extractDeclaration,
  extractParameter,
  scanConstructorBinding,
  extractForLoopBinding,
  extractPendingAssignment,
  extractPatternBinding,
  inferLiteralType,
};
