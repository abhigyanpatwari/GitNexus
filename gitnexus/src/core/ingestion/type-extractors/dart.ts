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
  ForLoopExtractor,
  LiteralTypeInferrer,
  ConstructorTypeDetector,
} from './types.js';
import { extractSimpleTypeName, extractVarName, extractElementTypeFromString, resolveIterableElementType } from './shared.js';
import { findChild } from '../utils/ast-helpers.js';

// ── Dart ──────────────────────────────────────────────────────────────────

const DART_DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'initialized_variable_definition',
  'initialized_identifier',
]);

const DART_FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'for_statement',
]);

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Parsed representation of the right-hand side of a Dart assignment.
 * tree-sitter-dart uses a flat sibling structure: identifier + selector + selector
 * rather than nested call_expression nodes.
 */
interface DartRHS {
  /** First identifier after `=` (callee or receiver) */
  callee?: string;
  /** Member access identifier from selector > unconditional_assignable_selector */
  member?: string;
  /** Whether there's a call (selector > argument_part) */
  hasCall: boolean;
  /** Whether value is wrapped in unary_expression > await_expression */
  isAwait: boolean;
}

/**
 * Parse RHS children from an initialized_variable_definition or await_expression.
 * Handles the flat sibling structure: identifier + selector(member) + selector(call).
 */
function parseDartRHSChildren(children: Iterable<SyntaxNode>): Omit<DartRHS, 'isAwait'> {
  let callee: string | undefined;
  let member: string | undefined;
  let hasCall = false;

  for (const child of children) {
    if (child.type === 'identifier' && !callee) {
      callee = child.text;
      continue;
    }
    if (child.type === 'selector') {
      // Member access: selector > unconditional_assignable_selector (.member)
      // or selector > conditional_assignable_selector (?.member)
      const uas = findChild(child, 'unconditional_assignable_selector')
        ?? findChild(child, 'conditional_assignable_selector');
      if (uas) {
        const id = findChild(uas, 'identifier');
        if (id && !member) member = id.text;
        continue;
      }
      if (findChild(child, 'argument_part')) {
        hasCall = true;
        continue;
      }
    }
    // Cascade: builder..add(1)..remove(2) — skip cascades for type inference
    // (the overall expression type is the receiver, not the cascaded method result)
  }

  return { callee, member, hasCall };
}

/**
 * Parse the RHS of an initialized_variable_definition.
 * Walks children after `=`, handling await wrapping.
 */
function parseDartRHS(node: SyntaxNode): DartRHS {
  // Collect children after '='
  const rhsChildren: SyntaxNode[] = [];
  let foundEquals = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && child.text === '=') { foundEquals = true; continue; }
    if (foundEquals) rhsChildren.push(child);
  }

  if (rhsChildren.length === 0) return { hasCall: false, isAwait: false };

  // Check for await wrapping: unary_expression > await_expression
  const first = rhsChildren[0];
  if (first.type === 'unary_expression') {
    const awaitExpr = findChild(first, 'await_expression');
    if (awaitExpr) {
      const innerChildren: SyntaxNode[] = [];
      for (let i = 0; i < awaitExpr.namedChildCount; i++) {
        const c = awaitExpr.namedChild(i);
        if (c && c.type !== 'await') innerChildren.push(c);
      }
      return { ...parseDartRHSChildren(innerChildren), isAwait: true };
    }
  }

  return { ...parseDartRHSChildren(rhsChildren), isAwait: false };
}

/** Check if an initialized_variable_definition has an explicit type annotation. */
function hasDartTypeAnnotation(node: SyntaxNode): boolean {
  return !!findChild(node, 'type_identifier');
}

// ── Tier 0: Explicit Type Annotations ───────────────────────────────────

/**
 * Dart: extract type from explicitly typed declarations.
 * `User user = ...` or `List<User> users = ...`
 *
 * tree-sitter-dart puts type_identifier as a positional child (NOT a field),
 * so childForFieldName('type') returns null.
 */
const extractDartDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  const typeNode = findChild(node, 'type_identifier');
  if (!typeNode) return; // var/final without type — skip (Tier 1 handles these)
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName || typeName === 'dynamic') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const varName = extractVarName(nameNode);
  if (varName) env.set(varName, typeName);
};

/**
 * Dart: extract type from function/method parameters.
 * `void foo(User user, String name)` — type is a positional child, not a field.
 */
const extractDartParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  const typeNode = findChild(node, 'type_identifier');
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName || typeName === 'dynamic') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const varName = extractVarName(nameNode);
  if (varName) env.set(varName, typeName);
};

// ── Tier 1: Constructor / Initializer Inference ─────────────────────────

/**
 * Dart: infer type from constructor calls on untyped declarations.
 * `var user = User()` or `final user = User.named()`
 *
 * Dart doesn't use `new`, so constructor calls look identical to function calls.
 * Must verify against classNames to distinguish User() (constructor) from getUser() (function).
 */
const extractDartInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup): void => {
  if (node.type !== 'initialized_variable_definition') return;
  // Skip if explicit type — Tier 0 handled it
  if (hasDartTypeAnnotation(node)) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const varName = extractVarName(nameNode);
  if (!varName || env.has(varName)) return;

  const rhs = parseDartRHS(node);
  if (!rhs.callee || !rhs.hasCall) return;

  // Direct constructor: var user = User()
  if (!rhs.member && classNames.has(rhs.callee)) {
    env.set(varName, rhs.callee);
    return;
  }

  // Named constructor: var user = User.named()
  if (rhs.member && classNames.has(rhs.callee)) {
    env.set(varName, rhs.callee);
  }
};

// ── Constructor Binding Scan (SymbolTable deferred validation) ──────────

/**
 * Dart: scan for untyped `var = callee()` patterns for return-type inference.
 * Returns { varName, calleeName } for later verification against SymbolTable.
 */
const scanDartConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'initialized_variable_definition') return undefined;
  if (hasDartTypeAnnotation(node)) return undefined;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const varName = nameNode.text;
  if (!varName) return undefined;

  const rhs = parseDartRHS(node);
  if (!rhs.callee) return undefined;

  // Direct call: var x = User() or var x = getUser()
  if (rhs.hasCall && !rhs.member) {
    return { varName, calleeName: rhs.callee };
  }

  // Qualified call: var x = svc.getUser() → callee is the method name
  if (rhs.hasCall && rhs.member) {
    return { varName, calleeName: rhs.member };
  }

  return undefined;
};

// ── Virtual Dispatch (Constructor Type Detection) ───────────────────────

/**
 * Dart: detect constructor-style calls for virtual dispatch.
 * For `Animal animal = Dog()`, returns 'Dog' when Dog is in classNames.
 */
const detectDartConstructorType: ConstructorTypeDetector = (node, classNames) => {
  if (node.type !== 'initialized_variable_definition') return undefined;

  const rhs = parseDartRHS(node);
  if (!rhs.callee || !rhs.hasCall) return undefined;

  // Direct: Dog()
  if (!rhs.member && classNames.has(rhs.callee)) return rhs.callee;
  // Named: Dog.named()
  if (rhs.member && classNames.has(rhs.callee)) return rhs.callee;

  return undefined;
};

// ── Literal Type Inference (Overload Disambiguation) ────────────────────

/**
 * Dart: map literal AST nodes to canonical Dart type names.
 */
const inferDartLiteralType: LiteralTypeInferrer = (node) => {
  switch (node.type) {
    case 'decimal_integer_literal':
    case 'hex_integer_literal':
      return 'int';
    case 'decimal_floating_point_literal':
      return 'double';
    case 'string_literal':
      return 'String';
    case 'true':
    case 'false':
      return 'bool';
    case 'null_literal':
      return 'null';
    default:
      return undefined;
  }
};

// ── Tier 2: Assignment Chain Propagation ─────────────────────────────────

/**
 * Dart: extract pending assignments for fixpoint resolution.
 * Handles: copy, callResult, fieldAccess, methodCallResult, and await wrapping.
 */
const extractDartPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type !== 'initialized_variable_definition') return undefined;
  if (hasDartTypeAnnotation(node)) return undefined;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const lhs = nameNode.text;
  if (!lhs || scopeEnv.has(lhs)) return undefined;

  const rhs = parseDartRHS(node);
  if (!rhs.callee) return undefined;

  // Bare identifier: var copy = user → copy
  if (!rhs.hasCall && !rhs.member) {
    return { kind: 'copy', lhs, rhs: rhs.callee };
  }

  // Field access: var name = user.name → fieldAccess
  if (!rhs.hasCall && rhs.member) {
    return { kind: 'fieldAccess', lhs, receiver: rhs.callee, field: rhs.member };
  }

  // Direct call: var user = getUser() → callResult
  if (rhs.hasCall && !rhs.member) {
    return { kind: 'callResult', lhs, callee: rhs.callee };
  }

  // Method call: var result = user.save() → methodCallResult
  if (rhs.hasCall && rhs.member) {
    return { kind: 'methodCallResult', lhs, receiver: rhs.callee, method: rhs.member };
  }

  return undefined;
};

// ── For-Loop Element Type Resolution ────────────────────────────────────

/**
 * Extract element type from a Dart type annotation node for for-in loops.
 * Handles List<User>, Set<User>, Map<K, V>, Iterable<User>, etc.
 */
function extractDartElementTypeFromTypeNode(typeNode: SyntaxNode): string | undefined {
  if (typeNode.type === 'type_identifier') {
    // Look for type_arguments sibling within parent
    const parent = typeNode.parent;
    if (parent) {
      const args = findChild(parent, 'type_arguments');
      if (args && args.namedChildCount >= 1) {
        // Use last type arg (Map<K, V> → V, List<T> → T)
        const lastArg = args.namedChild(args.namedChildCount - 1);
        if (lastArg) return extractSimpleTypeName(lastArg);
      }
    }
  }
  return undefined;
}

/**
 * Dart: extract loop variable type from for-in statements.
 * `for (var u in users)` — resolve element type from iterable.
 * `for (User u in users)` — extract type directly.
 */
const extractDartForLoopBinding: ForLoopExtractor = (node, ctx): void => {
  if (node.type !== 'for_statement') return;
  const { scopeEnv, declarationTypeNodes, scope, returnTypeLookup } = ctx;

  const loopParts = findChild(node, 'for_loop_parts');
  if (!loopParts) return;

  // Get loop variable name (name field)
  const nameNode = loopParts.childForFieldName('name');
  if (!nameNode) return;
  const loopVarName = nameNode.text;
  if (!loopVarName) return;

  // Check for explicit type annotation (positional type_identifier child)
  const typeNode = findChild(loopParts, 'type_identifier');
  if (typeNode) {
    const typeName = extractSimpleTypeName(typeNode);
    if (typeName && !scopeEnv.has(loopVarName)) {
      (scopeEnv as Map<string, string>).set(loopVarName, typeName);
    }
    return;
  }

  // Untyped (var/final): resolve element type from iterable
  const iterableNode = loopParts.childForFieldName('value');
  if (!iterableNode) return;

  let iterableName: string | undefined;
  let callExprElementType: string | undefined;

  if (iterableNode.type === 'identifier') {
    iterableName = iterableNode.text;
  } else if (iterableNode.type === 'unary_expression') {
    // await expression: for (var u in await getUsers())
    // Unwrap to find the inner call
    const awaitExpr = findChild(iterableNode, 'await_expression');
    if (awaitExpr) {
      const innerIdent = findChild(awaitExpr, 'identifier');
      if (innerIdent) iterableName = innerIdent.text;
    }
    if (!iterableName) return;
  }

  // Check if iterable is a call: identifier + selector(argument_part) siblings in for_loop_parts
  // For await iterables, selectors live inside the await_expression, not as siblings
  if (iterableName) {
    let hasCallSelector = false;
    let memberName: string | undefined;

    // Determine where to scan for selectors
    const selectorParent = iterableNode.type === 'unary_expression'
      ? findChild(iterableNode, 'await_expression')
      : loopParts;
    if (!selectorParent) return;

    let foundIterable = false;
    for (let i = 0; i < selectorParent.childCount; i++) {
      const child = selectorParent.child(i);
      if (!child) continue;
      // For await: skip past the identifier we already found
      if (child.type === 'identifier' && child.text === iterableName) { foundIterable = true; continue; }
      // For non-await: skip past the iterable node
      if (child === iterableNode) { foundIterable = true; continue; }
      if (!foundIterable) continue;
      if (child.type === 'selector') {
        const uas = findChild(child, 'unconditional_assignable_selector')
          ?? findChild(child, 'conditional_assignable_selector');
        if (uas) {
          const id = findChild(uas, 'identifier');
          if (id) memberName = id.text;
          continue;
        }
        if (findChild(child, 'argument_part')) {
          hasCallSelector = true;
        }
      }
    }

    if (hasCallSelector) {
      // Call expression iterable: for (var u in getUsers()) or for (var u in svc.getUsers())
      const callee = memberName ?? iterableName;
      const rawReturn = returnTypeLookup.lookupRawReturnType(callee);
      if (rawReturn) callExprElementType = extractElementTypeFromString(rawReturn);
    }
  }

  if (!iterableName && !callExprElementType) return;

  let elementType: string | undefined;
  if (callExprElementType) {
    elementType = callExprElementType;
  } else if (iterableName) {
    elementType = resolveIterableElementType(
      iterableName, node, scopeEnv, declarationTypeNodes, scope,
      extractDartElementTypeFromTypeNode,
    );
  }

  if (elementType && !scopeEnv.has(loopVarName)) {
    (scopeEnv as Map<string, string>).set(loopVarName, elementType);
  }
};

// ── Export ───────────────────────────────────────────────────────────────

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DART_DECLARATION_NODE_TYPES,
  forLoopNodeTypes: DART_FOR_LOOP_NODE_TYPES,
  extractDeclaration: extractDartDeclaration,
  extractParameter: extractDartParameter,
  extractInitializer: extractDartInitializer,
  scanConstructorBinding: scanDartConstructorBinding,
  extractForLoopBinding: extractDartForLoopBinding,
  extractPendingAssignment: extractDartPendingAssignment,
  inferLiteralType: inferDartLiteralType,
  detectConstructorType: detectDartConstructorType,
};
