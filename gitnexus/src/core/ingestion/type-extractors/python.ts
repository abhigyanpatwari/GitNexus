import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ClassNameLookup,
  ConstructorBindingScanner,
  PendingAssignmentExtractor,
  PatternBindingExtractor,
  ForLoopExtractor,
} from './types.js';
import {
  extractSimpleTypeName,
  extractVarName,
  extractElementTypeFromString,
  extractGenericTypeArgs,
  resolveIterableElementType,
  methodToTypeArgPosition,
  type TypeArgPosition,
} from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'assignment',
  'named_expression',
  'expression_statement',
]);

/** Python: x: Foo = ... (PEP 484 annotated assignment) or x: Foo (standalone annotation).
 *
 * tree-sitter-python grammar produces two distinct shapes:
 *
 *   1. Annotated assignment with value:  `name: str = ""`
 *      Node type: `assignment`
 *      Fields: left=identifier, type=identifier/type, right=value
 *
 *   2. Standalone annotation (no value):  `name: str`
 *      Node type: `expression_statement`
 *      Child: `type` node with fields name=identifier, type=identifier/type
 *
 * Both appear at file scope and inside class bodies (PEP 526 class variable annotations).
 */
const extractDeclaration: TypeBindingExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
): void => {
  if (node.type === 'expression_statement') {
    // Standalone annotation: expression_statement > type { name: identifier, type: identifier }
    const typeChild = node.firstNamedChild;
    if (!typeChild || typeChild.type !== 'type') return;
    const nameNode = typeChild.childForFieldName('name');
    const typeNode = typeChild.childForFieldName('type');
    if (!nameNode || !typeNode) return;
    const varName = extractVarName(nameNode);
    const inner = typeNode.type === 'type' ? (typeNode.firstNamedChild ?? typeNode) : typeNode;
    const typeName = extractSimpleTypeName(inner) ?? inner.text;
    if (varName && typeName) env.set(varName, typeName);
    return;
  }

  // Annotated assignment: left : type = value
  const left = node.childForFieldName('left');
  const typeNode = node.childForFieldName('type');
  if (!left || !typeNode) return;
  const varName = extractVarName(left);
  // extractSimpleTypeName handles identifiers and qualified names.
  // Python 3.10+ union syntax `User | None` is parsed as binary_operator,
  // which extractSimpleTypeName doesn't handle. Fall back to raw text so
  // stripNullable can process it at lookup time (e.g., "User | None" → "User").
  const inner = typeNode.type === 'type' ? (typeNode.firstNamedChild ?? typeNode) : typeNode;
  const typeName = extractSimpleTypeName(inner) ?? inner.text;
  if (varName && typeName) env.set(varName, typeName);
};

/** Python: parameter with type annotation */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('name');
    typeNode = node.childForFieldName('type');
  } else {
    nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
    typeNode = node.childForFieldName('type');
    // Python typed_parameter: name is a positional child (identifier), not a named field
    if (!nameNode && node.type === 'typed_parameter') {
      nameNode = node.firstNamedChild?.type === 'identifier' ? node.firstNamedChild : null;
    }
  }

  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Python: user = User("alice") — infer type from call when callee is a known class.
 *  Python constructors are syntactically identical to function calls, so we verify
 *  against classNames (which may include cross-file SymbolTable lookups).
 *  Also handles walrus operator: if (user := User("alice")): */
const extractInitializer: InitializerExtractor = (
  node: SyntaxNode,
  env: Map<string, string>,
  classNames: ClassNameLookup,
): void => {
  let left: SyntaxNode | null;
  let right: SyntaxNode | null;

  if (node.type === 'named_expression') {
    // Walrus operator: (user := User("alice"))
    // tree-sitter-python: named_expression has 'name' and 'value' fields
    left = node.childForFieldName('name');
    right = node.childForFieldName('value');
  } else if (node.type === 'assignment') {
    left = node.childForFieldName('left');
    right = node.childForFieldName('right');
    // Skip if already has type annotation — extractDeclaration handled it
    if (node.childForFieldName('type')) return;
  } else {
    return;
  }

  if (!left || !right) return;
  const varName = extractVarName(left);
  if (!varName || env.has(varName)) return;
  if (right.type !== 'call') return;
  const func = right.childForFieldName('function');
  if (!func) return;
  // Support both direct calls (User()) and qualified calls (models.User())
  // tree-sitter-python: direct → identifier, qualified → attribute
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return;
  if (classNames.has(calleeName)) {
    env.set(varName, calleeName);
  }
};

/** Python: user = User("alice") — scan assignment/walrus for constructor-like calls.
 *  Returns {varName, calleeName} without checking classNames (caller validates). */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  let left: SyntaxNode | null;
  let right: SyntaxNode | null;

  if (node.type === 'named_expression') {
    left = node.childForFieldName('name');
    right = node.childForFieldName('value');
  } else if (node.type === 'assignment') {
    left = node.childForFieldName('left');
    right = node.childForFieldName('right');
    if (node.childForFieldName('type')) return undefined;
  } else {
    return undefined;
  }

  if (!left || !right) return undefined;
  if (left.type !== 'identifier') return undefined;
  if (right.type !== 'call') return undefined;
  const func = right.childForFieldName('function');
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: left.text, calleeName };
};

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set(['for_statement']);

/** Python function/method node types that carry a parameters list. */
const PY_FUNCTION_NODE_TYPES = new Set(['function_definition', 'decorated_definition']);

/**
 * Extract element type from a Python type annotation AST node.
 * Handles:
 *   subscript "List[User]"  →  extractElementTypeFromString("List[User]") → "User"
 *   generic_type            →  extractGenericTypeArgs → first arg
 * Falls back to text-based extraction.
 */
const extractPyElementTypeFromAnnotation = (
  typeNode: SyntaxNode,
  pos: TypeArgPosition = 'last',
): string | undefined => {
  // Unwrap 'type' wrapper node to get to the actual type (e.g., type > generic_type)
  const inner = typeNode.type === 'type' ? (typeNode.firstNamedChild ?? typeNode) : typeNode;

  // Python subscript: List[User], Sequence[User] — use raw text
  if (inner.type === 'subscript') {
    return extractElementTypeFromString(inner.text, pos);
  }
  // generic_type: dict[str, User] — tree-sitter-python uses type_parameter child
  if (inner.type === 'generic_type') {
    // Try standard extractGenericTypeArgs first (handles type_arguments)
    const args = extractGenericTypeArgs(inner);
    if (args.length >= 1) return pos === 'first' ? args[0] : args[args.length - 1];
    // Fallback: look for type_parameter child (tree-sitter-python specific)
    for (let i = 0; i < inner.namedChildCount; i++) {
      const child = inner.namedChild(i);
      if (child?.type === 'type_parameter') {
        if (pos === 'first') {
          const firstArg = child.firstNamedChild;
          if (firstArg) return extractSimpleTypeName(firstArg);
        } else {
          const lastArg = child.lastNamedChild;
          if (lastArg) return extractSimpleTypeName(lastArg);
        }
      }
    }
  }
  // Fallback: raw text extraction (handles User[], [User], etc.)
  return extractElementTypeFromString(inner.text, pos);
};

/**
 * Walk up the AST from a for-statement to find the enclosing function definition,
 * then search its parameters for one named `iterableName`.
 * Returns the element type extracted from its type annotation, or undefined.
 *
 * Handles both `parameter` and `typed_parameter` node types in tree-sitter-python.
 * `typed_parameter` may not expose the name as a `name` field — falls back to
 * checking the first identifier-type named child.
 */
const findPyParamElementType = (
  iterableName: string,
  startNode: SyntaxNode,
  pos: TypeArgPosition = 'last',
): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  while (current) {
    if (current.type === 'function_definition') {
      const paramsNode = current.childForFieldName('parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const param = paramsNode.namedChild(i);
          if (!param) continue;
          // Try named `name` field first (parameter node), then first identifier child
          // (typed_parameter node may store name as first positional child)
          const nameNode =
            param.childForFieldName('name') ??
            (param.firstNamedChild?.type === 'identifier' ? param.firstNamedChild : null);
          if (nameNode?.text !== iterableName) continue;
          // Try `type` field, then last named child (typed_parameter stores type last)
          const typeAnnotation =
            param.childForFieldName('type') ??
            (param.namedChildCount >= 2 ? param.namedChild(param.namedChildCount - 1) : null);
          if (typeAnnotation && typeAnnotation !== nameNode) {
            return extractPyElementTypeFromAnnotation(typeAnnotation, pos);
          }
        }
      }
      break;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Extracts iterableName and methodName from a call expression like `data.items()`.
 * Returns undefined if the call doesn't match the expected pattern.
 */
const extractMethodCall = (
  callNode: SyntaxNode,
): { iterableName: string; methodName?: string } | undefined => {
  const fn = callNode.childForFieldName('function');
  if (fn?.type !== 'attribute') return undefined;
  const obj = fn.firstNamedChild;
  if (obj?.type !== 'identifier') return undefined;
  const method = fn.lastNamedChild;
  const methodName = method?.type === 'identifier' && method !== obj ? method.text : undefined;
  return { iterableName: obj.text, methodName };
};

/**
 * Collects all identifier nodes from a pattern, descending into nested tuple_patterns.
 * For `i, (k, v)` returns [i, k, v]. For `key, value` returns [key, value].
 */
const collectPatternIdentifiers = (pattern: SyntaxNode): SyntaxNode[] => {
  const vars: SyntaxNode[] = [];
  for (let i = 0; i < pattern.namedChildCount; i++) {
    const child = pattern.namedChild(i);
    if (child?.type === 'identifier') {
      vars.push(child);
    } else if (child?.type === 'tuple_pattern') {
      vars.push(...collectPatternIdentifiers(child));
    }
  }
  return vars;
};

/**
 * Python: for user in users: where users has a known container type annotation.
 *
 * AST node: `for_statement` with `left` (loop variable) and `right` (iterable).
 *
 * Tier 1c: resolves the element type via three strategies in priority order:
 *   1. declarationTypeNodes — raw type annotation AST node (covers stored container types)
 *   2. scopeEnv string — extractElementTypeFromString on the stored type
 *   3. AST walk — walks up to the enclosing function's parameters to read List[User] directly
 *
 * Also handles `enumerate(iterable)` — unwraps the outer call and skips the integer
 * index variable so the value variable still resolves to the element type.
 */
const extractForLoopBinding: ForLoopExtractor = (
  node,
  { scopeEnv, declarationTypeNodes, scope, returnTypeLookup },
): void => {
  if (node.type !== 'for_statement') return;

  const rightNode = node.childForFieldName('right');
  let iterableName: string | undefined;
  let methodName: string | undefined;
  let callExprElementType: string | undefined;
  let isEnumerate = false;

  // Extract iterable info from the `right` field — may be identifier, attribute, or call.
  if (rightNode?.type === 'identifier') {
    iterableName = rightNode.text;
  } else if (rightNode?.type === 'attribute') {
    const prop = rightNode.lastNamedChild;
    if (prop) iterableName = prop.text;
  } else if (rightNode?.type === 'call') {
    const fn = rightNode.childForFieldName('function');
    if (fn?.type === 'identifier' && fn.text === 'enumerate') {
      // enumerate(iterable) or enumerate(d.items()) — unwrap to inner iterable.
      isEnumerate = true;
      const innerArg = rightNode.childForFieldName('arguments')?.firstNamedChild;
      if (innerArg?.type === 'identifier') {
        iterableName = innerArg.text;
      } else if (innerArg?.type === 'call') {
        const extracted = extractMethodCall(innerArg);
        if (extracted) ({ iterableName, methodName } = extracted);
      }
    } else if (fn?.type === 'attribute') {
      // data.items() → call > function: attribute > identifier('data') + identifier('items')
      const extracted = extractMethodCall(rightNode);
      if (extracted) ({ iterableName, methodName } = extracted);
    } else if (fn?.type === 'identifier') {
      // Direct function call: for user in get_users() (Phase 7.3 — return-type path)
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
      extractPyElementTypeFromAnnotation,
      findPyParamElementType,
      typeArgPos,
    );
  }
  if (!elementType) return;

  // The loop variable is the `left` field — identifier or pattern_list.
  const leftNode = node.childForFieldName('left');
  if (!leftNode) return;

  if (leftNode.type === 'pattern_list' || leftNode.type === 'tuple_pattern') {
    // Tuple unpacking: `key, value` or `i, (k, v)` or `(k, v)` — bind the last identifier to element type.
    // With enumerate, skip binding if there's only one var (just the index, no value to bind).
    const vars = collectPatternIdentifiers(leftNode);
    if (vars.length > 0 && (!isEnumerate || vars.length > 1)) {
      scopeEnv.set(vars[vars.length - 1].text, elementType);
    }
    return;
  }

  const loopVarName = extractVarName(leftNode);
  if (loopVarName) scopeEnv.set(loopVarName, elementType);
};

/** Python: alias = u → assignment with left/right fields.
 *  Also handles walrus operator: alias := u → named_expression with name/value fields. */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  let left: SyntaxNode | null;
  let right: SyntaxNode | null;

  if (node.type === 'assignment') {
    left = node.childForFieldName('left');
    right = node.childForFieldName('right');
  } else if (node.type === 'named_expression') {
    left = node.childForFieldName('name');
    right = node.childForFieldName('value');
  } else {
    return undefined;
  }

  if (!left || !right) return undefined;
  const lhs = left.type === 'identifier' ? left.text : undefined;
  if (!lhs || scopeEnv.has(lhs)) return undefined;
  if (right.type === 'identifier') return { kind: 'copy', lhs, rhs: right.text };
  // attribute RHS → fieldAccess (a.field)
  if (right.type === 'attribute') {
    const obj = right.firstNamedChild;
    const field = right.lastNamedChild;
    if (obj?.type === 'identifier' && field?.type === 'identifier' && obj !== field) {
      return { kind: 'fieldAccess', lhs, receiver: obj.text, field: field.text };
    }
  }
  // call RHS
  if (right.type === 'call') {
    const funcNode = right.childForFieldName('function');
    if (funcNode?.type === 'identifier') {
      return { kind: 'callResult', lhs, callee: funcNode.text };
    }
    // method call with receiver: call → function: attribute
    if (funcNode?.type === 'attribute') {
      const obj = funcNode.firstNamedChild;
      const method = funcNode.lastNamedChild;
      if (obj?.type === 'identifier' && method?.type === 'identifier' && obj !== method) {
        return { kind: 'methodCallResult', lhs, receiver: obj.text, method: method.text };
      }
    }
  }
  return undefined;
};

/**
 * Python match/case `as` pattern binding: `case User() as u:`
 *
 * AST structure (tree-sitter-python):
 *   as_pattern
 *     alias: as_pattern_target   ← the bound variable name (e.g. "u")
 *     children[0]: case_pattern  ← wraps class_pattern (or is class_pattern directly)
 *       class_pattern
 *         dotted_name            ← the class name (e.g. "User")
 *
 * The `alias` field is an `as_pattern_target` node whose `.text` is the identifier.
 * The class name lives in the first non-alias named child: either a `case_pattern`
 * wrapping a `class_pattern`, or a direct `class_pattern`.
 *
 * Conservative: returns undefined when:
 * - The node is not an `as_pattern`
 * - The pattern side is not a class_pattern (e.g. guard or literal match)
 * - The variable was already bound in scopeEnv
 */
const extractPatternBinding: PatternBindingExtractor = (node, scopeEnv) => {
  if (node.type !== 'as_pattern') return undefined;

  // as_pattern: `case User() as u:` — binds matched value to a name.
  // Try named field first (future grammar versions may expose it), fall back to positional.
  if (node.namedChildCount < 2) return undefined;

  const patternChild = node.namedChild(0);
  const varNameNode = node.childForFieldName('alias') ?? node.namedChild(node.namedChildCount - 1);
  if (!patternChild || !varNameNode) return undefined;
  if (varNameNode.type !== 'identifier') return undefined;

  const varName = varNameNode.text;
  if (!varName || scopeEnv.has(varName)) return undefined;

  // Find the class_pattern — may be direct or wrapped in case_pattern.
  let classPattern: SyntaxNode | null = null;
  if (patternChild.type === 'class_pattern') {
    classPattern = patternChild;
  } else if (patternChild.type === 'case_pattern') {
    // Unwrap one level: case_pattern wraps class_pattern
    for (let j = 0; j < patternChild.namedChildCount; j++) {
      const inner = patternChild.namedChild(j);
      if (inner?.type === 'class_pattern') {
        classPattern = inner;
        break;
      }
    }
  }
  if (!classPattern) return undefined;

  // class_pattern children: dotted_name (the class name) + optional keyword_pattern args.
  const classNameNode = classPattern.firstNamedChild;
  if (
    !classNameNode ||
    (classNameNode.type !== 'dotted_name' && classNameNode.type !== 'identifier')
  )
    return undefined;
  const typeName = classNameNode.text;
  if (!typeName) return undefined;

  return { varName, typeName };
};

const PATTERN_BINDING_NODE_TYPES: ReadonlySet<string> = new Set(['as_pattern']);

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  patternBindingNodeTypes: PATTERN_BINDING_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
  extractForLoopBinding,
  extractPendingAssignment,
  extractPatternBinding,
};
