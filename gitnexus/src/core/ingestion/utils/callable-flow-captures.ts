/**
 * Configurable AST-to-`@callable-flow.*` capture synthesis.
 *
 * The traversal is language-neutral: providers supply their grammar's node
 * vocabulary and the small semantic callbacks (true-reference bindings,
 * callable signatures, protocol invocation names). The central extractor
 * never sees a parser node and shared ingestion code never branches on a
 * language name.
 */

import type { CaptureMatch, ParameterTypeClass } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from './ast-helpers.js';

export interface CallableCaptureSignature {
  readonly parameterCount?: number;
  readonly parameterTypes?: readonly string[];
  readonly parameterTypeClasses?: readonly ParameterTypeClass[];
}

export interface CallableFlowCaptureOptions {
  readonly functionNodeTypes: ReadonlySet<string>;
  readonly callNodeTypes: ReadonlySet<string>;
  readonly parameterListNodeTypes: ReadonlySet<string>;
  readonly parameterNodeTypes: ReadonlySet<string>;
  readonly bindingNodeTypes: ReadonlySet<string>;
  readonly assignmentNodeTypes: ReadonlySet<string>;
  readonly identifierNodeTypes: ReadonlySet<string>;
  /** Nodes that denote a named callable reference rather than a value read. */
  readonly callableReferenceNodeTypes?: ReadonlySet<string>;
  /** Member methods whose receiver itself is the callable object. */
  readonly callableProtocolMethods?: ReadonlySet<string>;
  /** Operators used for receiver-bound member-pointer invocation. */
  readonly memberPointerOperators?: ReadonlySet<string>;
  readonly functionName?: (node: SyntaxNode) => string | undefined;
  readonly parameterPassingMode?: (
    parameter: SyntaxNode,
  ) => 'value' | 'reference' | 'pointer' | 'callable-object';
  readonly isTrueReferenceBinding?: (container: SyntaxNode, destination: SyntaxNode) => boolean;
  readonly expectedSignature?: (
    container: SyntaxNode,
    destination: SyntaxNode,
  ) => CallableCaptureSignature | undefined;
  readonly normalizeQualifiedName?: (raw: string) => string;
}

interface OperandSyntax {
  readonly name: string;
  readonly node: SyntaxNode;
  readonly indirection: number;
  readonly addressOf: boolean;
  readonly qualifiedName?: string;
  readonly callableReference: boolean;
  readonly anonymousCallable: boolean;
}

interface AssignmentParts {
  readonly container: SyntaxNode;
  readonly destination: SyntaxNode;
  readonly source: SyntaxNode;
}

interface FunctionInfo {
  readonly node: SyntaxNode;
  readonly name: string;
  readonly parameters: readonly SyntaxNode[];
}

/**
 * Emit normalized flow captures in deterministic source order.
 *
 * One explicit DFS supplies all phases below. Query-backed emitters may still
 * perform their existing query walk; this helper never reparses and remains
 * linear in AST size (the scope-capture benchmark guards the scaling ratio).
 */
export function synthesizeCallableFlowCaptures(
  root: SyntaxNode,
  options: CallableFlowCaptureOptions,
): readonly CaptureMatch[] {
  const nodes = collectNodes(root);
  const functions = collectFunctions(nodes, options);
  const knownCallableNames = new Set(functions.map((fn) => fn.name));
  const assignments = collectAssignments(nodes, options);
  const assignedNames = new Set<string>();
  for (const assignment of assignments) {
    const destination = operandSyntax(assignment.destination, options);
    if (destination !== undefined) assignedNames.add(destination.name);
  }

  const formalNames = new Set<string>();
  for (const fn of functions) {
    for (const parameter of fn.parameters) {
      const bindingNode = bindingIdentifier(parameter, options);
      if (bindingNode !== undefined) formalNames.add(bindingNode.text);
    }
  }

  const out: CaptureMatch[] = [];
  for (const assignment of assignments) {
    emitAssignmentFact(assignment, knownCallableNames, assignedNames, formalNames, options, out);
  }
  for (const fn of functions) emitFormalFacts(fn, options, out);
  for (const node of nodes) {
    if (options.callNodeTypes.has(node.type)) {
      emitCallFacts(node, assignedNames, formalNames, options, out);
    }
  }

  out.sort((a, b) => compareCaptures(firstCapture(a), firstCapture(b)));
  return out;
}

function collectNodes(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== null) stack.push(child);
    }
  }
  return out;
}

function collectFunctions(
  nodes: readonly SyntaxNode[],
  options: CallableFlowCaptureOptions,
): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  for (const node of nodes) {
    if (!options.functionNodeTypes.has(node.type)) continue;
    const name = options.functionName?.(node) ?? defaultFunctionName(node, options);
    if (name === undefined || name.length === 0) continue;
    out.push({ node, name, parameters: functionParameters(node, options) });
  }
  return out;
}

function defaultFunctionName(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): string | undefined {
  const direct = node.childForFieldName('name');
  if (direct !== null) {
    const id = terminalIdentifier(direct, options);
    if (id !== undefined) return id.text;
  }
  const declarator = node.childForFieldName('declarator');
  if (declarator !== null) {
    const id = bindingIdentifier(declarator, options);
    if (id !== undefined) return id.text;
  }
  const parent = node.parent;
  if (parent !== null && options.bindingNodeTypes.has(parent.type)) {
    const destination = assignmentParts(parent, options)?.destination;
    if (destination !== undefined) return bindingIdentifier(destination, options)?.text;
  }
  return undefined;
}

function functionParameters(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): readonly SyntaxNode[] {
  const explicit =
    node.childForFieldName('parameters') ??
    node.childForFieldName('parameter') ??
    findFirstDescendantOfTypes(node, options.parameterListNodeTypes);
  if (explicit === null) return [];
  const direct = explicit.namedChildren.filter(
    (child): child is SyntaxNode =>
      child !== null &&
      (options.parameterNodeTypes.has(child.type) ||
        (options.parameterListNodeTypes.has(explicit.type) &&
          bindingIdentifier(child, options) !== undefined)),
  );
  return direct;
}

function collectAssignments(
  nodes: readonly SyntaxNode[],
  options: CallableFlowCaptureOptions,
): AssignmentParts[] {
  const out: AssignmentParts[] = [];
  const seen = new Set<number>();
  for (const node of nodes) {
    if (!options.bindingNodeTypes.has(node.type) && !options.assignmentNodeTypes.has(node.type)) {
      continue;
    }
    if (seen.has(node.id)) continue;
    const parts = assignmentParts(node, options);
    if (parts === undefined) continue;
    seen.add(node.id);
    out.push(parts);
  }
  return out;
}

function assignmentParts(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): AssignmentParts | undefined {
  const destination =
    node.childForFieldName('left') ??
    node.childForFieldName('name') ??
    node.childForFieldName('pattern') ??
    node.childForFieldName('declarator');
  const source =
    node.childForFieldName('right') ??
    node.childForFieldName('value') ??
    node.childForFieldName('initializer') ??
    node.childForFieldName('default_value');

  // Declaration wrappers often contain the real initialized declarator one
  // level below (for example a declarator list).
  if (destination === null || source === null) {
    for (const child of node.namedChildren) {
      if (child === null || child.id === node.id) continue;
      if (!options.bindingNodeTypes.has(child.type)) continue;
      const nested = assignmentParts(child, options);
      if (nested !== undefined) return nested;
    }
  }
  if (destination === null || source === null) return undefined;
  return { container: node, destination, source };
}

function emitAssignmentFact(
  assignment: AssignmentParts,
  knownCallableNames: ReadonlySet<string>,
  assignedNames: ReadonlySet<string>,
  formalNames: ReadonlySet<string>,
  options: CallableFlowCaptureOptions,
  out: CaptureMatch[],
): void {
  const destination = operandSyntax(assignment.destination, options);
  const source = operandSyntax(assignment.source, options);
  if (destination === undefined || source === undefined) return;

  const signature = options.expectedSignature?.(assignment.container, assignment.destination);
  const sourceIsKnownCallable =
    knownCallableNames.has(source.name) ||
    source.callableReference ||
    source.anonymousCallable ||
    (source.qualifiedName !== undefined && !assignedNames.has(source.name)) ||
    (signature !== undefined && !assignedNames.has(source.name) && !formalNames.has(source.name));

  if (destination.indirection > 0) {
    out.push(binaryFact('store', assignment.container, 'pointer', destination, 'source', source));
    return;
  }
  if (source.addressOf && !sourceIsKnownCallable) {
    // An address of a value binding creates an abstract-cell edge. Addresses
    // of named callables are seeds instead (function designator semantics).
    if (assignedNames.has(source.name) || formalNames.has(source.name)) {
      out.push(
        binaryFact('address', assignment.container, 'destination', destination, 'source', source),
      );
    }
    return;
  }
  if (source.indirection > 0 && !sourceIsKnownCallable) {
    out.push(
      binaryFact('load', assignment.container, 'destination', destination, 'pointer', source),
    );
    return;
  }
  if (sourceIsKnownCallable) {
    const match: Record<string, ReturnType<typeof nodeToCapture>> = {
      '@callable-flow.seed': nodeToCapture('@callable-flow.seed', assignment.container),
      '@callable-flow.destination': operandCapture('@callable-flow.destination', destination),
      '@callable-flow.target': operandCapture('@callable-flow.target', source),
      '@callable-flow.target-name': syntheticCapture(
        '@callable-flow.target-name',
        source.node,
        source.anonymousCallable ? destination.name : source.name,
      ),
    };
    if (source.qualifiedName !== undefined) {
      match['@callable-flow.target-qualified-name'] = syntheticCapture(
        '@callable-flow.target-qualified-name',
        source.node,
        options.normalizeQualifiedName?.(source.qualifiedName) ?? source.qualifiedName,
      );
    }
    addSignatureCaptures(match, assignment.container, signature);
    out.push(match);
    return;
  }

  const kind = options.isTrueReferenceBinding?.(assignment.container, assignment.destination)
    ? 'alias'
    : 'copy';
  out.push(binaryFact(kind, assignment.container, 'destination', destination, 'source', source));
}

function emitFormalFacts(
  fn: FunctionInfo,
  options: CallableFlowCaptureOptions,
  out: CaptureMatch[],
): void {
  for (let index = 0; index < fn.parameters.length; index++) {
    const parameter = fn.parameters[index]!;
    const binding = bindingIdentifier(parameter, options);
    if (binding === undefined) continue;
    const mode = options.parameterPassingMode?.(parameter) ?? 'value';
    const match: Record<string, ReturnType<typeof nodeToCapture>> = {
      '@callable-flow.formal': nodeToCapture('@callable-flow.formal', fn.node),
      '@callable-flow.owner': syntheticCapture('@callable-flow.owner', fn.node, fn.name),
      '@callable-flow.binding': syntheticCapture('@callable-flow.binding', binding, binding.text),
      '@callable-flow.parameter-index': syntheticCapture(
        '@callable-flow.parameter-index',
        binding,
        String(index),
      ),
      '@callable-flow.passing-mode': syntheticCapture(
        '@callable-flow.passing-mode',
        parameter,
        mode,
      ),
    };
    out.push(match);
  }
}

function emitCallFacts(
  call: SyntaxNode,
  assignedNames: ReadonlySet<string>,
  formalNames: ReadonlySet<string>,
  options: CallableFlowCaptureOptions,
  out: CaptureMatch[],
): void {
  const calleeNode =
    call.childForFieldName('function') ??
    call.childForFieldName('callee') ??
    call.childForFieldName('name') ??
    call.childForFieldName('method');
  if (calleeNode === null) return;

  const args = callArguments(call, options);
  for (let index = 0; index < args.length; index++) {
    const source = operandSyntax(args[index]!, options);
    if (source === undefined) continue;
    out.push({
      '@callable-flow.argument': nodeToCapture('@callable-flow.argument', call),
      '@callable-flow.source': operandCapture('@callable-flow.source', source),
      ...(source.indirection > 0
        ? {
            '@callable-flow.source-indirection': syntheticCapture(
              '@callable-flow.source-indirection',
              source.node,
              String(source.indirection),
            ),
          }
        : {}),
      ...(source.addressOf
        ? {
            '@callable-flow.source-address': syntheticCapture(
              '@callable-flow.source-address',
              source.node,
              'true',
            ),
          }
        : {}),
      '@callable-flow.parameter-index': syntheticCapture(
        '@callable-flow.parameter-index',
        args[index]!,
        String(index),
      ),
    });
  }

  const member = memberParts(calleeNode, options);
  if (member !== undefined) {
    if (
      member.operator !== undefined &&
      options.memberPointerOperators?.has(member.operator) === true
    ) {
      emitInvoke(call, member.member, 'member-pointer', args.length, out, member.receiver);
      return;
    }
    if (options.callableProtocolMethods?.has(member.member.name) === true) {
      emitInvoke(call, member.receiver, 'callable-object', args.length, out);
    }
    return;
  }

  const callee = operandSyntax(calleeNode, options);
  if (callee === undefined) return;
  if (callee.indirection > 0 || assignedNames.has(callee.name) || formalNames.has(callee.name)) {
    emitInvoke(call, callee, 'indirect', args.length, out);
  }
}

function emitInvoke(
  call: SyntaxNode,
  callee: OperandSyntax,
  invocationKind: 'indirect' | 'member-pointer' | 'callable-object',
  arity: number,
  out: CaptureMatch[],
  receiver?: OperandSyntax,
): void {
  out.push({
    '@callable-flow.invoke': nodeToCapture('@callable-flow.invoke', call),
    '@callable-flow.callee': operandCapture('@callable-flow.callee', callee),
    ...(callee.indirection > 0
      ? {
          '@callable-flow.callee-indirection': syntheticCapture(
            '@callable-flow.callee-indirection',
            callee.node,
            String(callee.indirection),
          ),
        }
      : {}),
    ...(receiver !== undefined
      ? { '@callable-flow.receiver': operandCapture('@callable-flow.receiver', receiver) }
      : {}),
    '@callable-flow.invocation-kind': syntheticCapture(
      '@callable-flow.invocation-kind',
      call,
      invocationKind,
    ),
    '@callable-flow.arity': syntheticCapture('@callable-flow.arity', call, String(arity)),
  });
}

function callArguments(
  call: SyntaxNode,
  options: CallableFlowCaptureOptions,
): readonly SyntaxNode[] {
  const list =
    call.childForFieldName('arguments') ??
    call.childForFieldName('argument') ??
    call.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null && options.parameterListNodeTypes.has(child.type),
    ) ??
    null;
  if (list === null) return [];
  if (options.parameterListNodeTypes.has(list.type)) {
    return list.namedChildren.filter(
      (child): child is SyntaxNode => child !== null && child.type !== 'comment',
    );
  }
  return [list];
}

function memberParts(
  input: SyntaxNode,
  options: CallableFlowCaptureOptions,
):
  | { readonly receiver: OperandSyntax; readonly member: OperandSyntax; readonly operator?: string }
  | undefined {
  let node = input;
  for (let guard = 0; guard < 8; guard++) {
    const wrapped = wrappedExpression(node);
    if (wrapped === null) break;
    node = wrapped;
  }
  const receiverNode =
    node.childForFieldName('object') ??
    node.childForFieldName('argument') ??
    node.childForFieldName('receiver');
  const memberNode =
    node.childForFieldName('property') ??
    node.childForFieldName('field') ??
    node.childForFieldName('method');
  if (receiverNode === null || memberNode === null) return undefined;
  const receiver = operandSyntax(receiverNode, options);
  const member = operandSyntax(memberNode, options);
  if (receiver === undefined || member === undefined) return undefined;
  const operator = node.children.find(
    (child) =>
      options.memberPointerOperators?.has(child.type) === true ||
      options.memberPointerOperators?.has(child.text) === true,
  );
  return { receiver, member, ...(operator !== undefined ? { operator: operator.text } : {}) };
}

function operandSyntax(
  input: SyntaxNode,
  options: CallableFlowCaptureOptions,
): OperandSyntax | undefined {
  let node = input;
  let indirection = 0;
  let addressOf = false;

  for (let guard = 0; guard < 16; guard++) {
    if (options.functionNodeTypes.has(node.type)) {
      return {
        name: '<anonymous>',
        node,
        indirection,
        addressOf,
        callableReference: true,
        anonymousCallable: true,
      };
    }
    const operator = unaryOperator(node);
    if (operator === '&') addressOf = true;
    if (operator === '*') indirection++;
    const wrapped = wrappedExpression(node);
    if (wrapped === null) break;
    node = wrapped;
  }

  const id = terminalIdentifier(node, options);
  if (id === undefined) return undefined;
  const isQualified = id.id !== node.id && hasMultipleIdentifierLeaves(node, options);
  return {
    name: id.text,
    node: id,
    indirection,
    addressOf,
    ...(isQualified ? { qualifiedName: node.text } : {}),
    callableReference: options.callableReferenceNodeTypes?.has(node.type) === true,
    anonymousCallable: false,
  };
}

function wrappedExpression(node: SyntaxNode): SyntaxNode | null {
  const field =
    node.childForFieldName('argument') ??
    node.childForFieldName('expression') ??
    node.childForFieldName('value');
  if (field !== null && field.id !== node.id && node.namedChildCount === 1) return field;
  if (
    node.type.includes('parenthesized') ||
    node.type.includes('reference_expression') ||
    node.type.includes('pointer_expression') ||
    node.type.includes('unary_expression') ||
    node.type.includes('cast_expression')
  ) {
    return node.namedChild(node.namedChildCount - 1);
  }
  return null;
}

function unaryOperator(node: SyntaxNode): string | undefined {
  for (const child of node.children) {
    if (child.text === '&' || child.text === '*') return child.text;
  }
  const trimmed = node.text.trimStart();
  if (trimmed.startsWith('&')) return '&';
  if (trimmed.startsWith('*')) return '*';
  return undefined;
}

function bindingIdentifier(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): SyntaxNode | undefined {
  if (options.identifierNodeTypes.has(node.type)) return node;
  for (const fieldName of ['name', 'declarator', 'pattern', 'left']) {
    const field = node.childForFieldName(fieldName);
    if (field === null || field.id === node.id) continue;
    const found = bindingIdentifier(field, options);
    if (found !== undefined) return found;
  }
  for (const child of node.namedChildren) {
    if (child === null) continue;
    const found = bindingIdentifier(child, options);
    if (found !== undefined) return found;
  }
  return undefined;
}

function terminalIdentifier(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): SyntaxNode | undefined {
  if (options.identifierNodeTypes.has(node.type)) return node;
  for (const fieldName of ['name', 'property', 'field', 'method', 'declarator']) {
    const field = node.childForFieldName(fieldName);
    if (field === null || field.id === node.id) continue;
    const found = terminalIdentifier(field, options);
    if (found !== undefined) return found;
  }
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (child === null) continue;
    const found = terminalIdentifier(child, options);
    if (found !== undefined) return found;
  }
  return undefined;
}

function hasMultipleIdentifierLeaves(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): boolean {
  let count = 0;
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (options.identifierNodeTypes.has(current.type)) {
      if (++count > 1) return true;
      continue;
    }
    for (const child of current.namedChildren) if (child !== null) stack.push(child);
  }
  return false;
}

function findFirstDescendantOfTypes(
  root: SyntaxNode,
  types: ReadonlySet<string>,
): SyntaxNode | null {
  const stack: SyntaxNode[] = [...root.namedChildren].filter(
    (child): child is SyntaxNode => child !== null,
  );
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (types.has(node.type)) return node;
    for (const child of node.namedChildren) if (child !== null) stack.push(child);
  }
  return null;
}

function binaryFact(
  kind: 'copy' | 'alias' | 'address' | 'store' | 'load',
  anchor: SyntaxNode,
  leftRole: 'destination' | 'pointer',
  left: OperandSyntax,
  rightRole: 'source' | 'pointer',
  right: OperandSyntax,
): CaptureMatch {
  return {
    [`@callable-flow.${kind}`]: nodeToCapture(`@callable-flow.${kind}`, anchor),
    [`@callable-flow.${leftRole}`]: operandCapture(`@callable-flow.${leftRole}`, left),
    ...(left.indirection > 0
      ? {
          [`@callable-flow.${leftRole}-indirection`]: syntheticCapture(
            `@callable-flow.${leftRole}-indirection`,
            left.node,
            String(left.indirection),
          ),
        }
      : {}),
    [`@callable-flow.${rightRole}`]: operandCapture(`@callable-flow.${rightRole}`, right),
    ...(right.indirection > 0
      ? {
          [`@callable-flow.${rightRole}-indirection`]: syntheticCapture(
            `@callable-flow.${rightRole}-indirection`,
            right.node,
            String(right.indirection),
          ),
        }
      : {}),
  };
}

function operandCapture(name: string, operand: OperandSyntax) {
  return syntheticCapture(name, operand.node, operand.name);
}

function addSignatureCaptures(
  match: Record<string, ReturnType<typeof nodeToCapture>>,
  anchor: SyntaxNode,
  signature: CallableCaptureSignature | undefined,
): void {
  if (signature?.parameterCount !== undefined) {
    match['@callable-flow.expected-arity'] = syntheticCapture(
      '@callable-flow.expected-arity',
      anchor,
      String(signature.parameterCount),
    );
  }
  if (signature?.parameterTypes !== undefined) {
    match['@callable-flow.expected-types'] = syntheticCapture(
      '@callable-flow.expected-types',
      anchor,
      JSON.stringify(signature.parameterTypes),
    );
  }
  if (signature?.parameterTypeClasses !== undefined) {
    match['@callable-flow.expected-type-classes'] = syntheticCapture(
      '@callable-flow.expected-type-classes',
      anchor,
      JSON.stringify(signature.parameterTypeClasses),
    );
  }
}

function firstCapture(match: CaptureMatch) {
  return Object.values(match)[0];
}

function compareCaptures(
  a: ReturnType<typeof nodeToCapture> | undefined,
  b: ReturnType<typeof nodeToCapture> | undefined,
): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return (
    a.range.startLine - b.range.startLine ||
    a.range.startCol - b.range.startCol ||
    a.name.localeCompare(b.name)
  );
}
