/**
 * Dart type extractor — full implementation following type-resolution-system.md.
 *
 * Tier 0: Explicit type annotations (User user = ...)
 * Tier 0b: For-loop element types (for (var u in users))
 * Tier 1: Constructor/initializer inference (var user = User())
 * Tier 2: Assignment chain propagation (copy, fieldAccess, callResult, methodCallResult)
 *
 * Handles tree-sitter-dart's flat sibling AST structure:
 * identifier + selector + selector (not nested call_expression).
 *
 * Credit: Type resolution approach adapted from @xFlaviews' PR #83.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ClassNameLookup,
  ConstructorBindingScanner,
  PendingAssignmentExtractor,
  ForLoopExtractor,
  LiteralTypeInferrer,
  ConstructorTypeDetector,
} from './types.js';
import { extractSimpleTypeName, extractVarName, extractElementTypeFromString, resolveIterableElementType } from './shared.js';
import { findChild } from '../utils/ast-helpers.js';

// ── Node types ──────────────────────────────────────────────────────────

const DART_DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'initialized_variable_definition',
  'initialized_identifier',
]);

const DART_FOR_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'for_statement',
]);

// ── Helpers ─────────────────────────────────────────────────────────────

interface DartRHS {
  callee?: string;
  member?: string;
  hasCall: boolean;
  isAwait: boolean;
}

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
  }

  return { callee, member, hasCall };
}

function parseDartRHS(node: SyntaxNode): DartRHS {
  const rhsChildren: SyntaxNode[] = [];
  let foundEquals = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && child.text === '=') { foundEquals = true; continue; }
    if (foundEquals) rhsChildren.push(child);
  }

  if (rhsChildren.length === 0) return { hasCall: false, isAwait: false };

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

function hasDartTypeAnnotation(node: SyntaxNode): boolean {
  return !!(findChild(node, 'type_identifier') || findChild(node, 'nullable_type'));
}

// ── Tier 0: Explicit Type Annotations ───────────────────────────────────

const extractDartDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let typeNode = findChild(node, 'type_identifier');
  if (!typeNode) {
    const nullable = findChild(node, 'nullable_type');
    if (nullable) typeNode = findChild(nullable, 'type_identifier');
  }
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName || typeName === 'dynamic') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const varName = extractVarName(nameNode);
  if (varName) env.set(varName, typeName);
};

const extractDartParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  let typeNode = findChild(node, 'type_identifier');
  if (!typeNode) {
    const nullable = findChild(node, 'nullable_type');
    if (nullable) typeNode = findChild(nullable, 'type_identifier');
  }
  if (!typeNode) return;
  const typeName = extractSimpleTypeName(typeNode);
  if (!typeName || typeName === 'dynamic') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const varName = extractVarName(nameNode);
  if (varName) env.set(varName, typeName);
};

// ── Tier 1: Constructor / Initializer Inference ─────────────────────────

const extractDartInitializer: InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup): void => {
  if (node.type !== 'initialized_variable_definition') return;
  if (hasDartTypeAnnotation(node)) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const varName = extractVarName(nameNode);
  if (!varName || env.has(varName)) return;

  const rhs = parseDartRHS(node);
  if (!rhs.callee || !rhs.hasCall) return;

  if (!rhs.member && classNames.has(rhs.callee)) {
    env.set(varName, rhs.callee);
    return;
  }

  if (rhs.member && classNames.has(rhs.callee)) {
    env.set(varName, rhs.callee);
  }
};

// ── Constructor Binding Scan ────────────────────────────────────────────

const scanDartConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'initialized_variable_definition') return undefined;
  if (hasDartTypeAnnotation(node)) return undefined;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const varName = nameNode.text;
  if (!varName) return undefined;

  const rhs = parseDartRHS(node);
  if (!rhs.callee) return undefined;

  if (rhs.hasCall && !rhs.member) return { varName, calleeName: rhs.callee };
  if (rhs.hasCall && rhs.member) return { varName, calleeName: rhs.member };

  return undefined;
};

// ── Virtual Dispatch ────────────────────────────────────────────────────

const detectDartConstructorType: ConstructorTypeDetector = (node, classNames) => {
  if (node.type !== 'initialized_variable_definition') return undefined;

  const rhs = parseDartRHS(node);
  if (!rhs.callee || !rhs.hasCall) return undefined;

  if (!rhs.member && classNames.has(rhs.callee)) return rhs.callee;
  if (rhs.member && classNames.has(rhs.callee)) return rhs.callee;

  return undefined;
};

// ── Literal Type Inference ──────────────────────────────────────────────

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

const extractDartPendingAssignment: PendingAssignmentExtractor = (node, scopeEnv) => {
  if (node.type !== 'initialized_variable_definition') return undefined;
  if (hasDartTypeAnnotation(node)) return undefined;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const lhs = nameNode.text;
  if (!lhs || scopeEnv.has(lhs)) return undefined;

  const rhs = parseDartRHS(node);
  if (!rhs.callee) return undefined;

  if (!rhs.hasCall && !rhs.member) return { kind: 'copy', lhs, rhs: rhs.callee };
  if (!rhs.hasCall && rhs.member) return { kind: 'fieldAccess', lhs, receiver: rhs.callee, field: rhs.member };
  if (rhs.hasCall && !rhs.member) return { kind: 'callResult', lhs, callee: rhs.callee };
  if (rhs.hasCall && rhs.member) return { kind: 'methodCallResult', lhs, receiver: rhs.callee, method: rhs.member };

  return undefined;
};

// ── For-Loop Element Type Resolution ────────────────────────────────────

function extractDartElementTypeFromTypeNode(typeNode: SyntaxNode): string | undefined {
  if (typeNode.type === 'type_identifier') {
    const parent = typeNode.parent;
    if (parent) {
      const args = findChild(parent, 'type_arguments');
      if (args && args.namedChildCount >= 1) {
        const lastArg = args.namedChild(args.namedChildCount - 1);
        if (lastArg) return extractSimpleTypeName(lastArg);
      }
    }
  }
  return undefined;
}

const extractDartForLoopBinding: ForLoopExtractor = (node, ctx): void => {
  if (node.type !== 'for_statement') return;
  const { scopeEnv, declarationTypeNodes, scope, returnTypeLookup } = ctx;

  const loopParts = findChild(node, 'for_loop_parts');
  if (!loopParts) return;

  const nameNode = loopParts.childForFieldName('name');
  if (!nameNode) return;
  const loopVarName = nameNode.text;
  if (!loopVarName) return;

  const typeNode = findChild(loopParts, 'type_identifier');
  if (typeNode) {
    const typeName = extractSimpleTypeName(typeNode);
    if (typeName && !scopeEnv.has(loopVarName)) {
      (scopeEnv as Map<string, string>).set(loopVarName, typeName);
    }
    return;
  }

  const iterableNode = loopParts.childForFieldName('value');
  if (!iterableNode) return;

  let iterableName: string | undefined;
  let callExprElementType: string | undefined;

  if (iterableNode.type === 'identifier') {
    iterableName = iterableNode.text;
  } else if (iterableNode.type === 'unary_expression') {
    const awaitExpr = findChild(iterableNode, 'await_expression');
    if (awaitExpr) {
      const innerIdent = findChild(awaitExpr, 'identifier');
      if (innerIdent) iterableName = innerIdent.text;
    }
    if (!iterableName) return;
  }

  if (iterableName) {
    let hasCallSelector = false;
    let memberName: string | undefined;

    const selectorParent = iterableNode.type === 'unary_expression'
      ? findChild(iterableNode, 'await_expression')
      : loopParts;
    if (!selectorParent) return;

    let foundIterable = false;
    for (let i = 0; i < selectorParent.childCount; i++) {
      const child = selectorParent.child(i);
      if (!child) continue;
      if (child.type === 'identifier' && child.text === iterableName) { foundIterable = true; continue; }
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
