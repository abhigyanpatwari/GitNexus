import { findChild, type SyntaxNode } from '../utils/ast-helpers.js';
import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ClassNameLookup,
  ConstructorBindingScanner,
  PendingAssignmentExtractor,
  PendingAssignment,
  ForLoopExtractor,
} from './types.js';
import {
  extractSimpleTypeName,
  extractVarName,
  hasTypeAnnotation,
  extractElementTypeFromString,
  resolveIterableElementType,
} from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'property_declaration',
  'if_statement',
  'guard_statement',
]);

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['for_statement']);

/**
 * Unwrap Swift `await_expression` and `try_expression` nodes to find the inner
 * call_expression or other value node. `try` nodes contain a `try_operator` child
 * that must be skipped.
 */
function unwrapSwiftExpression(node: SyntaxNode): SyntaxNode {
  if (node.type === 'await_expression' || node.type === 'try_expression') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type !== 'try_operator') return unwrapSwiftExpression(child);
    }
  }
  return node;
}

/** Swift: let x: Foo = ... */
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  // Swift property_declaration has pattern and type_annotation
  const pattern = node.childForFieldName('pattern') ?? findChild(node, 'pattern');
  const typeAnnotation = node.childForFieldName('type') ?? findChild(node, 'type_annotation');
  if (!pattern || !typeAnnotation) return;
  const varName = extractVarName(pattern) ?? pattern.text;
  const typeName = extractSimpleTypeName(typeAnnotation);
  if (varName && typeName) env.set(varName, typeName);
};

/** Swift: parameter → name: type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('internal_name');
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

/** Swift: let user = User(name: "alice") — infer type from call when callee is a known class.
 *  Swift initializers are syntactically identical to function calls, so we verify
 *  against classNames (which may include cross-file SymbolTable lookups). */
const extractInitializer: InitializerExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
  classNames: ClassNameLookup,
): void => {
  if (node.type !== 'property_declaration') return;
  // Skip if has type annotation — extractDeclaration handled it
  if (node.childForFieldName('type') || findChild(node, 'type_annotation')) return;
  // Find pattern (variable name)
  const pattern = node.childForFieldName('pattern') ?? findChild(node, 'pattern');
  if (!pattern) return;
  const varName = extractVarName(pattern) ?? pattern.text;
  if (!varName || env.has(varName)) return;
  // Find call_expression in the value (unwrap await/try)
  let callExpr = findChild(node, 'call_expression');
  if (!callExpr) {
    // Check for await_expression or try_expression wrapping a call_expression
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'await_expression' || child.type === 'try_expression')) {
        const unwrapped = unwrapSwiftExpression(child);
        if (unwrapped.type === 'call_expression') {
          callExpr = unwrapped;
          break;
        }
      }
    }
  }
  if (!callExpr) return;
  const callee = callExpr.firstNamedChild;
  if (!callee) return;
  // Direct call: User(name: "alice")
  if (callee.type === 'simple_identifier') {
    const calleeName = callee.text;
    if (calleeName && classNames.has(calleeName)) {
      env.set(varName, calleeName);
    }
    return;
  }
  // Explicit init: User.init(name: "alice") — navigation_expression with .init suffix
  if (callee.type === 'navigation_expression') {
    const receiver = callee.firstNamedChild;
    const suffix = callee.lastNamedChild;
    if (receiver?.type === 'simple_identifier' && suffix?.text === 'init') {
      const calleeName = receiver.text;
      if (calleeName && classNames.has(calleeName)) {
        env.set(varName, calleeName);
      }
    }
  }
};

/** Swift: let user = User(name: "alice") — scan property_declaration for constructor binding */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'property_declaration') return undefined;
  if (hasTypeAnnotation(node)) return undefined;
  const pattern = node.childForFieldName('pattern');
  if (!pattern) return undefined;
  const varName = pattern.text;
  if (!varName) return undefined;
  let callExpr: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'call_expression') {
      callExpr = child;
      break;
    }
    // Unwrap await/try to find inner call_expression
    if (child && (child.type === 'await_expression' || child.type === 'try_expression')) {
      const unwrapped = unwrapSwiftExpression(child);
      if (unwrapped.type === 'call_expression') {
        callExpr = unwrapped;
        break;
      }
    }
  }
  if (!callExpr) return undefined;
  const callee = callExpr.firstNamedChild;
  if (!callee) return undefined;
  if (callee.type === 'simple_identifier') {
    return { varName, calleeName: callee.text };
  }
  if (callee.type === 'navigation_expression') {
    const receiver = callee.firstNamedChild;
    const suffix = callee.lastNamedChild;
    if (receiver?.type === 'simple_identifier' && suffix?.text === 'init') {
      return { varName, calleeName: receiver.text };
    }
    // General qualified call: service.getUser() → extract method name.
    // tree-sitter-swift may wrap the identifier in navigation_suffix, so
    // check both direct simple_identifier and navigation_suffix > simple_identifier.
    if (suffix?.type === 'simple_identifier') {
      return { varName, calleeName: suffix.text };
    }
    if (suffix?.type === 'navigation_suffix') {
      const inner = suffix.lastNamedChild;
      if (inner?.type === 'simple_identifier') {
        return { varName, calleeName: inner.text };
      }
    }
  }
  return undefined;
};

/**
 * Extract the variable name from an if_statement or guard_statement with optional binding.
 * Pattern: `if let varName = expr` / `guard let varName = expr`
 * AST: if_statement/guard_statement contains value_binding_pattern, then simple_identifier (varName),
 * then call_expression/simple_identifier/navigation_expression (value).
 */
function extractIfGuardBinding(
  node: SyntaxNode,
  scopeEnv: ReadonlyMap<string, string>,
): PendingAssignment | undefined {
  // Find value_binding_pattern to confirm this is an optional binding
  let hasValueBinding = false;
  let varName: string | undefined;
  let valueNode: SyntaxNode | null = null;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'value_binding_pattern') {
      hasValueBinding = true;
      continue;
    }
    if (hasValueBinding && !varName && child.type === 'simple_identifier') {
      varName = child.text;
      continue;
    }
    if (varName && !valueNode) {
      // Skip type annotations and binding operators
      if (child.type === 'type_annotation') continue;
      valueNode = child;
      break;
    }
  }

  if (!hasValueBinding || !varName || !valueNode || scopeEnv.has(varName)) return undefined;

  // Unwrap await/try
  valueNode = unwrapSwiftExpression(valueNode);

  // simple_identifier → copy
  if (valueNode.type === 'simple_identifier') {
    return { kind: 'copy', lhs: varName, rhs: valueNode.text };
  }

  // navigation_expression → fieldAccess
  if (valueNode.type === 'navigation_expression') {
    const receiver = valueNode.firstNamedChild;
    const suffix = valueNode.lastNamedChild;
    if (receiver?.type === 'simple_identifier' && suffix?.type === 'navigation_suffix') {
      const field = suffix.lastNamedChild;
      if (field?.type === 'simple_identifier') {
        return { kind: 'fieldAccess', lhs: varName, receiver: receiver.text, field: field.text };
      }
    }
    return undefined;
  }

  // call_expression → callResult or methodCallResult
  if (valueNode.type === 'call_expression') {
    const callee = valueNode.firstNamedChild;
    if (!callee) return undefined;
    if (callee.type === 'simple_identifier') {
      return { kind: 'callResult', lhs: varName, callee: callee.text };
    }
    if (callee.type === 'navigation_expression') {
      const receiver = callee.firstNamedChild;
      const suffix = callee.lastNamedChild;
      if (receiver?.type === 'simple_identifier' && suffix?.type === 'navigation_suffix') {
        const method = suffix.lastNamedChild;
        if (method?.type === 'simple_identifier') {
          return {
            kind: 'methodCallResult',
            lhs: varName,
            receiver: receiver.text,
            method: method.text,
          };
        }
      }
    }
  }

  return undefined;
}

/**
 * Swift: extract pending assignments for Tier 2 return-type propagation.
 * Handles:
 *   let user = getUser()           → callResult
 *   let result = user.save()       → methodCallResult
 *   let name = user.name           → fieldAccess
 *   let copy = user                → copy
 *   let user = await getUser()     → callResult (unwrapped)
 *   let user = try getUser()       → callResult (unwrapped)
 *   if let user = getUser()        → callResult (optional binding)
 *   guard let user = getUser()     → callResult (optional binding)
 */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  // Handle if_statement and guard_statement optional bindings
  if (node.type === 'if_statement' || node.type === 'guard_statement') {
    return extractIfGuardBinding(node, scopeEnv);
  }

  if (node.type !== 'property_declaration') return undefined;
  // Skip if type annotation exists — extractDeclaration handles it
  if (hasTypeAnnotation(node)) return undefined;

  // Find the variable name from the pattern child
  let lhs: string | undefined;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'pattern') {
      lhs = child.text;
      break;
    }
  }
  if (!lhs || scopeEnv.has(lhs)) return undefined;

  // Find the value expression (last meaningful named child after pattern)
  let valueNode: SyntaxNode | null = null;
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (
      child.type === 'pattern' ||
      child.type === 'value_binding_pattern' ||
      child.type === 'type_annotation'
    )
      continue;
    valueNode = child;
    break;
  }
  if (!valueNode) return undefined;

  // Unwrap await/try expressions (Feature 2)
  valueNode = unwrapSwiftExpression(valueNode);

  // let copy = user → copy
  if (valueNode.type === 'simple_identifier') {
    return { kind: 'copy', lhs, rhs: valueNode.text };
  }

  // let name = user.name → fieldAccess
  if (valueNode.type === 'navigation_expression') {
    const receiver = valueNode.firstNamedChild;
    const suffix = valueNode.lastNamedChild;
    if (receiver?.type === 'simple_identifier' && suffix?.type === 'navigation_suffix') {
      const field = suffix.lastNamedChild;
      if (field?.type === 'simple_identifier') {
        return { kind: 'fieldAccess', lhs, receiver: receiver.text, field: field.text };
      }
    }
    return undefined;
  }

  // Call expressions
  if (valueNode.type === 'call_expression') {
    const callee = valueNode.firstNamedChild;
    if (!callee) return undefined;

    // let user = getUser() → callResult
    if (callee.type === 'simple_identifier') {
      return { kind: 'callResult', lhs, callee: callee.text };
    }

    // let result = user.save() → methodCallResult
    if (callee.type === 'navigation_expression') {
      const receiver = callee.firstNamedChild;
      const suffix = callee.lastNamedChild;
      if (receiver?.type === 'simple_identifier' && suffix?.type === 'navigation_suffix') {
        const method = suffix.lastNamedChild;
        if (method?.type === 'simple_identifier') {
          return { kind: 'methodCallResult', lhs, receiver: receiver.text, method: method.text };
        }
      }
    }
  }

  return undefined;
};

/**
 * Swift: extract loop variable type binding from `for item in collection`.
 * AST: for_statement with pattern > simple_identifier (loop var) and
 * a simple_identifier/call_expression (collection).
 */
const extractForLoopBinding: ForLoopExtractor = (
  node,
  { scopeEnv, declarationTypeNodes, scope, returnTypeLookup },
): void => {
  if (node.type !== 'for_statement') return;

  // Find the loop variable from the pattern child
  let loopVarName: string | undefined;
  let iterableNode: SyntaxNode | null = null;

  // for_statement children: pattern (loop var), then the iterable expression, then the body
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'pattern' || child.type === 'simple_identifier') {
      if (!loopVarName) {
        // Extract a simple identifier from the pattern. Skip non-trivial patterns
        // (e.g. tuple destructuring `for (a, b) in ...`) to avoid polluting scopeEnv.
        const varName =
          extractVarName(child) ?? (child.type === 'simple_identifier' ? child.text : undefined);
        if (!varName) return; // Non-simple pattern — bail out
        loopVarName = varName;
        continue;
      }
    }
    // After we found the loop var, the next expression-like node is the iterable
    if (loopVarName && !iterableNode) {
      if (
        child.type === 'simple_identifier' ||
        child.type === 'call_expression' ||
        child.type === 'navigation_expression'
      ) {
        iterableNode = child;
        break;
      }
    }
  }

  if (!loopVarName || !iterableNode) return;

  let iterableName: string | undefined;
  let callExprElementType: string | undefined;

  if (iterableNode.type === 'simple_identifier') {
    iterableName = iterableNode.text;
  } else if (iterableNode.type === 'navigation_expression') {
    // collection.property
    const suffix = iterableNode.lastNamedChild;
    if (suffix?.type === 'navigation_suffix') {
      const prop = suffix.lastNamedChild;
      if (prop?.type === 'simple_identifier') iterableName = prop.text;
    } else if (suffix?.type === 'simple_identifier') {
      iterableName = suffix.text;
    }
  } else if (iterableNode.type === 'call_expression') {
    // getItems() or collection.values()
    const fn = iterableNode.firstNamedChild;
    let callee: string | undefined;
    if (fn?.type === 'simple_identifier') {
      callee = fn.text;
    } else if (fn?.type === 'navigation_expression') {
      const obj = fn.firstNamedChild;
      const suffix = fn.lastNamedChild;
      if (obj?.type === 'simple_identifier') iterableName = obj.text;
      if (suffix?.type === 'navigation_suffix') {
        const m = suffix.lastNamedChild;
        if (m?.type === 'simple_identifier') callee = m.text;
      } else if (suffix?.type === 'simple_identifier') {
        callee = suffix.text;
      }
    }
    if (callee) {
      const rawReturn = returnTypeLookup.lookupRawReturnType(callee);
      if (rawReturn) callExprElementType = extractElementTypeFromString(rawReturn);
    }
  }

  if (!iterableName && !callExprElementType) return;

  let elementType: string | undefined;
  if (callExprElementType) {
    elementType = callExprElementType;
  } else if (iterableName) {
    // Try to resolve element type from the iterable's declared type
    elementType = resolveIterableElementType(
      iterableName,
      node,
      scopeEnv,
      declarationTypeNodes,
      scope,
      extractSwiftElementTypeFromTypeNode,
    );
  }

  if (elementType && !scopeEnv.has(loopVarName)) {
    (scopeEnv as Map<string, string>).set(loopVarName, elementType);
  }
};

/**
 * Extract element type from a Swift type annotation AST node.
 * Handles: [User] (array sugar), Array<User>, Set<User>, etc.
 */
function extractSwiftElementTypeFromTypeNode(typeNode: SyntaxNode): string | undefined {
  // Swift array sugar: [User] — parsed as array_type > user_type > type_identifier
  if (typeNode.type === 'array_type') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSimpleTypeName(inner);
  }
  // Generic type: Array<User>, Set<User>
  if (typeNode.type === 'user_type') {
    // Check for generic args: user_type > type_identifier + type_arguments
    for (let i = 0; i < typeNode.namedChildCount; i++) {
      const child = typeNode.namedChild(i);
      if (child?.type === 'type_arguments') {
        const lastArg = child.lastNamedChild;
        if (lastArg) return extractSimpleTypeName(lastArg);
      }
    }
  }
  // type_annotation wrapping
  if (typeNode.type === 'type_annotation') {
    const inner = typeNode.firstNamedChild;
    if (inner) return extractSwiftElementTypeFromTypeNode(inner);
  }
  return undefined;
}

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  getDeclarationTypeNode: (node) => {
    // Swift: many declarations store type as a type_annotation child (not a 'type' field).
    // Prefer a direct 'type' field if present, else unwrap type_annotation to its inner type.
    const direct = node.childForFieldName('type');
    if (direct) return direct;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'type_annotation') return c.firstNamedChild ?? c;
    }
    return null;
  },
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
  extractPendingAssignment,
  extractForLoopBinding,
};
