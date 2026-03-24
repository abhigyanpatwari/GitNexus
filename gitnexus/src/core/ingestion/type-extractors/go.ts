import type { SyntaxNode } from '../utils.js';
import type { ConstructorBindingScanner, ForLoopExtractor, LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, PendingAssignmentExtractor } from './types.js';
import { extractSimpleTypeName, extractVarName, extractElementTypeFromString, extractGenericTypeArgs, resolveIterableElementType, methodToTypeArgPosition, type TypeArgPosition } from './shared.js';

const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'var_declaration',
  'var_spec',
  'short_var_declaration',
]);

/** Go: var x Foo */
const extractGoVarDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  // Go var_declaration contains var_spec children
  if (node.type === 'var_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const spec = node.namedChild(i);
      if (spec?.type === 'var_spec') extractGoVarDeclaration(spec, env);
    }
    return;
  }

  // var_spec: name type [= value]
  const nameNode = node.childForFieldName('name');
  const typeNode = node.childForFieldName('type');
  if (!nameNode || !typeNode) return;
  const varName = extractVarName(nameNode);
  const typeName = extractSimpleTypeName(typeNode);
  if (varName && typeName) env.set(varName, typeName);
};

/** Go: x := Foo{...} — infer type from composite literal (handles multi-assignment) */
const extractGoShortVarDeclaration = (node: SyntaxNode, env: Map<string, string>): void => {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;

  // Collect LHS names and RHS values (may be expression_lists for multi-assignment)
  const lhsNodes: SyntaxNode[] = [];
  const rhsNodes: SyntaxNode[] = [];

  if (left.type === 'expression_list') {
    for (let i = 0; i < left.namedChildCount; i++) {
      const c = left.namedChild(i);
      if (c) lhsNodes.push(c);
    }
  } else {
    lhsNodes.push(left);
  }

  if (right.type === 'expression_list') {
    for (let i = 0; i < right.namedChildCount; i++) {
      const c = right.namedChild(i);
      if (c) rhsNodes.push(c);
    }
  } else {
    rhsNodes.push(right);
  }

  // Pair each LHS name with its corresponding RHS value
  const count = Math.min(lhsNodes.length, rhsNodes.length);
  for (let i = 0; i < count; i++) {
    let valueNode = rhsNodes[i];
    // Unwrap &User{} — unary_expression (address-of) wrapping composite_literal
    if (valueNode.type === 'unary_expression' && valueNode.firstNamedChild?.type === 'composite_literal') {
      valueNode = valueNode.firstNamedChild;
    }
    // Go built-in new(User) — call_expression with 'new' callee and type argument
    // Go built-in make([]User, 0) / make(map[string]User) — extract element/value type
    if (valueNode.type === 'call_expression') {
      const funcNode = valueNode.childForFieldName('function');
      if (funcNode?.text === 'new') {
        const args = valueNode.childForFieldName('arguments');
        if (args?.firstNamedChild) {
          const typeName = extractSimpleTypeName(args.firstNamedChild);
          const varName = extractVarName(lhsNodes[i]);
          if (varName && typeName) env.set(varName, typeName);
        }
      } else if (funcNode?.text === 'make') {
        const args = valueNode.childForFieldName('arguments');
        const firstArg = args?.firstNamedChild;
        if (firstArg) {
          let innerType: SyntaxNode | null = null;
          if (firstArg.type === 'slice_type') {
            innerType = firstArg.childForFieldName('element');
          } else if (firstArg.type === 'map_type') {
            innerType = firstArg.childForFieldName('value');
          }
          if (innerType) {
            const typeName = extractSimpleTypeName(innerType);
            const varName = extractVarName(lhsNodes[i]);
            if (varName && typeName) env.set(varName, typeName);
          }
        }
      }
      continue;
    }
    // Go type assertion: user := iface.(User) — type_assertion_expression with 'type' field
    if (valueNode.type === 'type_assertion_expression') {
      const typeNode = valueNode.childForFieldName('type');
      if (typeNode) {
        const typeName = extractSimpleTypeName(typeNode);
        const varName = extractVarName(lhsNodes[i]);
        if (varName && typeName) env.set(varName, typeName);
      }
      continue;
    }
    if (valueNode.type !== 'composite_literal') continue;
    const typeNode = valueNode.childForFieldName('type');
    if (!typeNode) continue;
    const typeName = extractSimpleTypeName(typeNode);
    if (!typeName) continue;
    const varName = extractVarName(lhsNodes[i]);
    if (varName) env.set(varName, typeName);
  }
};

const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type === 'var_declaration' || node.type === 'var_spec') {
    extractGoVarDeclaration(node, env);
  } else if (node.type === 'short_var_declaration') {
    extractGoShortVarDeclaration(node, env);
  }
};

/** Go: parameter → name type */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let nameNode: SyntaxNode | null = null;
  let typeNode: SyntaxNode | null = null;

  if (node.type === 'parameter') {
    nameNode = node.childForFieldName('name');
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

/** Go: user := NewUser(...) — infer type from single-assignment call expression */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'short_var_declaration') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  const leftIds = left.type === 'expression_list' ? left.namedChildren : [left];
  const rightExprs = right.type === 'expression_list' ? right.namedChildren : [right];

  // Multi-return: user, err := NewUser() — bind first var when second is err/ok/_
  if (leftIds.length === 2 && rightExprs.length === 1) {
    const secondVar = leftIds[1];
    const isErrorOrDiscard =
      secondVar.text === '_' ||
      secondVar.text === 'err' ||
      secondVar.text === 'ok' ||
      secondVar.text === 'error';
    if (isErrorOrDiscard && leftIds[0].type === 'identifier') {
      if (rightExprs[0].type !== 'call_expression') return undefined;
      const func = rightExprs[0].childForFieldName('function');
      if (!func) return undefined;
      if (func.text === 'new' || func.text === 'make') return undefined;
      const calleeName = extractSimpleTypeName(func);
      if (!calleeName) return undefined;
      return { varName: leftIds[0].text, calleeName };
    }
  }

  // Single assignment only
  if (leftIds.length !== 1 || leftIds[0].type !== 'identifier') return undefined;
  if (rightExprs.length !== 1 || rightExprs[0].type !== 'call_expression') return undefined;
  const func = rightExprs[0].childForFieldName('function');
  if (!func) return undefined;
  // Skip new() and make() — already handled by extractDeclaration
  if (func.text === 'new' || func.text === 'make') return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: leftIds[0].text, calleeName };
};

const FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'for_statement',
]);

/** Go function/method node types that carry a parameter list. */
const GO_FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'method_declaration', 'func_literal',
]);

/**
 * Extract element type from a Go type annotation AST node.
 * Handles:
 *   slice_type "[]User"  →  element field → type_identifier "User"
 *   array_type "[10]User" →  element field → type_identifier "User"
 * Falls back to text-based extraction via extractElementTypeFromString.
 */
const extractGoElementTypeFromTypeNode = (typeNode: SyntaxNode, pos: TypeArgPosition = 'last'): string | undefined => {
  // slice_type: []User — element field is the element type
  if (typeNode.type === 'slice_type' || typeNode.type === 'array_type') {
    const elemNode = typeNode.childForFieldName('element');
    if (elemNode) return extractSimpleTypeName(elemNode);
  }
  // map_type: map[string]User — value field is the element type (for range, second var gets value)
  if (typeNode.type === 'map_type') {
    const valueNode = typeNode.childForFieldName('value');
    if (valueNode) return extractSimpleTypeName(valueNode);
  }
  // channel_type: chan User — the type argument is the element type
  if (typeNode.type === 'channel_type') {
    const valueNode = typeNode.childForFieldName('value') ?? typeNode.lastNamedChild;
    if (valueNode) return extractSimpleTypeName(valueNode);
  }
  // generic_type: Go 1.18+ generics (e.g., MySlice[User], Cache[string, User])
  // Use position-aware arg selection: 'first' for keys, 'last' for values.
  if (typeNode.type === 'generic_type') {
    const args = extractGenericTypeArgs(typeNode);
    if (args.length >= 1) return pos === 'first' ? args[0] : args[args.length - 1];
  }
  // Fallback: text-based extraction ([]User → User, User[] → User)
  return extractElementTypeFromString(typeNode.text, pos);
};

/** Check if a Go type node represents a channel type. Used to determine
 *  whether single-var range yields the element (channels) vs index (slices/maps). */
const isChannelType = (
  iterableName: string,
  scopeEnv: ReadonlyMap<string, string>,
  declarationTypeNodes?: ReadonlyMap<string, SyntaxNode>,
  scope?: string,
): boolean => {
  if (declarationTypeNodes && scope) {
    const typeNode = declarationTypeNodes.get(`${scope}\0${iterableName}`);
    if (typeNode) return typeNode.type === 'channel_type';
  }
  const t = scopeEnv.get(iterableName);
  return !!t && t.startsWith('chan ');
};

/**
 * Walk up the AST from a for-statement to find the enclosing function declaration,
 * then search its parameters for one named `iterableName`.
 * Returns the element type extracted from its type annotation, or undefined.
 *
 * Go parameter_declaration has:
 *   name field: identifier (the parameter name)
 *   type field: the type node (slice_type for []User)
 */
const findGoParamElementType = (iterableName: string, startNode: SyntaxNode, pos: TypeArgPosition = 'last'): string | undefined => {
  let current: SyntaxNode | null = startNode.parent;
  while (current) {
    if (GO_FUNCTION_NODE_TYPES.has(current.type)) {
      const paramsNode = current.childForFieldName('parameters');
      if (paramsNode) {
        for (let i = 0; i < paramsNode.namedChildCount; i++) {
          const paramDecl = paramsNode.namedChild(i);
          if (!paramDecl || paramDecl.type !== 'parameter_declaration') continue;
          // parameter_declaration: name type — name field is the identifier
          const nameNode = paramDecl.childForFieldName('name');
          if (nameNode?.text === iterableName) {
            const typeNode = paramDecl.childForFieldName('type');
            if (typeNode) return extractGoElementTypeFromTypeNode(typeNode, pos);
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
 * Go: for _, user := range users where users has a known slice type.
 *
 * Go uses a single `for_statement` node for all for-loop forms. We detect
 * range-based loops by looking for a `range_clause` child node. C-style for
 * loops (with `for_clause`) and infinite loops (no clause) are ignored.
 *
 * Tier 1c: resolves the element type via three strategies in priority order:
 *   1. declarationTypeNodes — raw type annotation AST node
 *   2. scopeEnv string — extractElementTypeFromString on the stored type
 *   3. AST walk — walks up to the enclosing function's parameters to read []User directly
 * For `_, user := range users`, the loop variable is the second identifier in
 * the `left` expression_list (index is discarded, value is the element).
 */
const extractForLoopBinding: ForLoopExtractor = (node, { scopeEnv, declarationTypeNodes, scope, returnTypeLookup }): void => {
  if (node.type !== 'for_statement') return;

  // Find the range_clause child — this distinguishes range loops from other for forms.
  let rangeClause: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'range_clause') {
      rangeClause = child;
      break;
    }
  }
  if (!rangeClause) return;

  // The iterable is the `right` field of the range_clause.
  const rightNode = rangeClause.childForFieldName('right');
  let iterableName: string | undefined;
  let callExprElementType: string | undefined;
  if (rightNode?.type === 'identifier') {
    iterableName = rightNode.text;
  } else if (rightNode?.type === 'selector_expression') {
    const field = rightNode.childForFieldName('field');
    if (field) iterableName = field.text;
  } else if (rightNode?.type === 'call_expression') {
    // Range over a call result: `for _, v := range getItems()` or `for _, v := range repo.All()`
    const funcNode = rightNode.childForFieldName('function');
    let callee: string | undefined;
    if (funcNode?.type === 'identifier') {
      callee = funcNode.text;
    } else if (funcNode?.type === 'selector_expression') {
      const field = funcNode.childForFieldName('field');
      if (field) callee = field.text;
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
  } else {
    const containerTypeName = scopeEnv.get(iterableName!);
    const typeArgPos = methodToTypeArgPosition(undefined, containerTypeName);
    elementType = resolveIterableElementType(
      iterableName!, node, scopeEnv, declarationTypeNodes, scope,
      extractGoElementTypeFromTypeNode, findGoParamElementType,
      typeArgPos,
    );
  }
  if (!elementType) return;

  // The loop variable(s) are in the `left` field.
  // Go range semantics:
  //   Slice/Array/String: single-var → INDEX (int); two-var → (index, element)
  //   Map:                single-var → KEY; two-var → (key, value)
  //   Channel:            single-var → ELEMENT (channels have no index)
  const leftNode = rangeClause.childForFieldName('left');
  if (!leftNode) return;

  let loopVarNode: SyntaxNode | null = null;
  if (leftNode.type === 'expression_list') {
    if (leftNode.namedChildCount >= 2) {
      // Two-var form: `_, user` or `i, user` — second variable gets element/value type
      loopVarNode = leftNode.namedChild(1);
    } else {
      // Single-var in expression_list — yields INDEX for slices/maps, ELEMENT for channels.
      // For call-expression iterables (iterableName undefined), conservative: treat as non-channel.
      // Channels are rarely returned from function calls, and even if they were, skipping here
      // just means we miss a binding rather than create an incorrect one.
      if (iterableName && isChannelType(iterableName, scopeEnv, declarationTypeNodes, scope)) {
        loopVarNode = leftNode.namedChild(0);
      } else {
        return; // index-only range on slice/map — skip
      }
    }
  } else {
    // Plain identifier (single-var form without expression_list)
    // For call-expression iterables (iterableName undefined), conservative: treat as non-channel.
    // Channels are rarely returned from function calls, and even if they were, skipping here
    // just means we miss a binding rather than create an incorrect one.
    if (iterableName && isChannelType(iterableName, scopeEnv, declarationTypeNodes, scope)) {
      loopVarNode = leftNode;
    } else {
      return; // index-only range on slice/map — skip
    }
  }
  if (!loopVarNode) return;

  // Skip the blank identifier `_`
  if (loopVarNode.text === '_') return;

  const loopVarName = extractVarName(loopVarNode);
  if (loopVarName) scopeEnv.set(loopVarName, elementType);
};

/** Go: alias := u (short_var_declaration) or var b = u (var_spec) */
const extractPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type === 'short_var_declaration') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right) return undefined;
    const lhsNode = left.type === 'expression_list' ? left.firstNamedChild : left;
    const rhsNode = right.type === 'expression_list' ? right.firstNamedChild : right;
    if (!lhsNode || !rhsNode) return undefined;
    if (lhsNode.type !== 'identifier') return undefined;
    const lhs = lhsNode.text;
    if (scopeEnv.has(lhs)) return undefined;
    if (rhsNode.type === 'identifier') return { kind: 'copy', lhs, rhs: rhsNode.text };
    // selector_expression RHS → fieldAccess (a.field)
    if (rhsNode.type === 'selector_expression') {
      const operand = rhsNode.childForFieldName('operand');
      const field = rhsNode.childForFieldName('field');
      if (operand?.type === 'identifier' && field) {
        return { kind: 'fieldAccess', lhs, receiver: operand.text, field: field.text };
      }
    }
    // call_expression RHS
    if (rhsNode.type === 'call_expression') {
      const funcNode = rhsNode.childForFieldName('function');
      if (funcNode?.type === 'identifier') {
        return { kind: 'callResult', lhs, callee: funcNode.text };
      }
      // method call with receiver: call_expression → function: selector_expression
      if (funcNode?.type === 'selector_expression') {
        const operand = funcNode.childForFieldName('operand');
        const field = funcNode.childForFieldName('field');
        if (operand?.type === 'identifier' && field) {
          return { kind: 'methodCallResult', lhs, receiver: operand.text, method: field.text };
        }
      }
    }
    return undefined;
  }
  if (node.type === 'var_spec' || node.type === 'var_declaration') {
    // var_declaration contains var_spec children; var_spec has name + expression_list value
    const specs: SyntaxNode[] = [];
    if (node.type === 'var_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c?.type === 'var_spec') specs.push(c);
      }
    } else {
      specs.push(node);
    }
    for (const spec of specs) {
      const nameNode = spec.childForFieldName('name');
      if (!nameNode || nameNode.type !== 'identifier') continue;
      const lhs = nameNode.text;
      if (scopeEnv.has(lhs)) continue;
      // Check if the last named child is a bare identifier (no type annotation between name and value)
      let exprList: SyntaxNode | null = null;
      for (let i = 0; i < spec.childCount; i++) {
        if (spec.child(i)?.type === 'expression_list') { exprList = spec.child(i); break; }
      }
      const rhsNode = exprList?.firstNamedChild;
      if (rhsNode?.type === 'identifier') return { kind: 'copy', lhs, rhs: rhsNode.text };
      // selector_expression RHS → fieldAccess
      if (rhsNode?.type === 'selector_expression') {
        const operand = rhsNode.childForFieldName('operand');
        const field = rhsNode.childForFieldName('field');
        if (operand?.type === 'identifier' && field) {
          return { kind: 'fieldAccess', lhs, receiver: operand.text, field: field.text };
        }
      }
      // call_expression RHS
      if (rhsNode?.type === 'call_expression') {
        const funcNode = rhsNode.childForFieldName('function');
        if (funcNode?.type === 'identifier') {
          return { kind: 'callResult', lhs, callee: funcNode.text };
        }
        if (funcNode?.type === 'selector_expression') {
          const operand = funcNode.childForFieldName('operand');
          const field = funcNode.childForFieldName('field');
          if (operand?.type === 'identifier' && field) {
            return { kind: 'methodCallResult', lhs, receiver: operand.text, method: field.text };
          }
        }
      }
    }
  }
  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  forLoopNodeTypes: FOR_LOOP_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  scanConstructorBinding,
  extractForLoopBinding,
  extractPendingAssignment,
};
