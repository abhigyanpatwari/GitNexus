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
  readonly isConst?: boolean;
}

export interface CallableFlowCaptureOptions {
  readonly functionNodeTypes: ReadonlySet<string>;
  readonly callNodeTypes: ReadonlySet<string>;
  readonly parameterListNodeTypes: ReadonlySet<string>;
  readonly parameterNodeTypes: ReadonlySet<string>;
  readonly bindingNodeTypes: ReadonlySet<string>;
  readonly assignmentNodeTypes: ReadonlySet<string>;
  readonly identifierNodeTypes: ReadonlySet<string>;
  /** Control-flow blocks do not introduce a new local-variable scope. */
  readonly functionScopedValueBindings?: boolean;
  /**
   * Declaration nodes whose callable type can contextually select an overload
   * at a later assignment (for example `void (*fp)(int); fp = target;`).
   */
  readonly callableSignatureDeclarationNodeTypes?: ReadonlySet<string>;
  /** Nodes that denote a named callable reference rather than a value read. */
  readonly callableReferenceNodeTypes?: ReadonlySet<string>;
  /** Member methods whose receiver itself is the callable object. */
  readonly callableProtocolMethods?: ReadonlySet<string>;
  /** Operators used for receiver-bound member-pointer invocation. */
  readonly memberPointerOperators?: ReadonlySet<string>;
  /** Provider fallback for member-pointer syntax a grammar recovers as ERROR nodes. */
  readonly memberPointerParts?: (node: SyntaxNode) =>
    | {
        readonly receiver: SyntaxNode;
        readonly member: SyntaxNode;
        readonly operator: string;
      }
    | undefined;
  readonly functionName?: (node: SyntaxNode) => string | undefined;
  /** Map grammar-specific split signature/body shapes to one lexical owner. */
  readonly lexicalFunctionOwner?: (node: SyntaxNode) => SyntaxNode | undefined;
  readonly parameterPassingMode?: (
    parameter: SyntaxNode,
  ) => 'value' | 'reference' | 'pointer' | 'callable-object';
  readonly isTrueReferenceBinding?: (container: SyntaxNode, destination: SyntaxNode) => boolean;
  readonly expectedSignature?: (
    container: SyntaxNode,
    destination: SyntaxNode,
  ) => CallableCaptureSignature | undefined;
  readonly normalizeQualifiedName?: (raw: string) => string;
  /**
   * Provider-owned assignment decomposition. May return MULTIPLE pairs for
   * one node — Go's multi-value `a, b := f, g` pairs positionally; the
   * shared field fallback would cross-wire first-LHS with last-RHS (#2522
   * review). Returning an empty array means "recognized, but emit nothing"
   * (e.g. a multi-return call RHS with mismatched arity).
   */
  readonly extractAssignment?: (
    node: SyntaxNode,
  ) =>
    | { readonly destination: SyntaxNode; readonly source: SyntaxNode }
    | readonly { readonly destination: SyntaxNode; readonly source: SyntaxNode }[]
    | undefined;
  readonly extractFunctionParameters?: (node: SyntaxNode) => readonly SyntaxNode[] | undefined;
  readonly extractCallCallee?: (node: SyntaxNode) => SyntaxNode | undefined;
  readonly isCallNode?: (node: SyntaxNode) => boolean;
  /**
   * Languages where a bare, receiver-less, paren-less name in value position
   * is a CALL, not a reference (Ruby: `action = process` invokes `process`
   * and stores its return). When true, a bare name that is not a provably
   * local value binding and not an explicit reference form (`method(:x)`,
   * lambda/proc) emits NO flow fact — treating it as a callable minted CALLS
   * edges to methods that were merely invoked (#2522 review).
   */
  readonly bareNamesAreCalls?: boolean;
  readonly callSiteNode?: (node: SyntaxNode) => SyntaxNode | undefined;
  /** Emit a canonical call ReferenceSite when the provider query omits variable calls. */
  readonly emitCanonicalInvokeReference?: boolean;
  readonly extractCallableReference?: (node: SyntaxNode) =>
    | {
        readonly name: string;
        readonly anchor: SyntaxNode;
        readonly qualifiedName?: string;
      }
    | undefined;
}

interface OperandSyntax {
  readonly name: string;
  readonly node: SyntaxNode;
  readonly indirection: number;
  readonly addressOf: boolean;
  readonly qualifiedName?: string;
  readonly directDesignator: boolean;
  readonly callableReference: boolean;
  readonly anonymousCallable: boolean;
  readonly expressionKind:
    | 'binding'
    | 'callable-designator'
    | 'bound-member'
    | 'anonymous-callable';
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

interface ValueBindingIndex {
  readonly assignmentRegionIdsByName: ReadonlyMap<string, ReadonlySet<number>>;
  readonly formalByOwner: ReadonlyMap<number | undefined, ReadonlySet<string>>;
  readonly signatureByNameAndRegion: ReadonlyMap<
    string,
    ReadonlyMap<number, CallableCaptureSignature>
  >;
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
  const valueBindings = buildValueBindingIndex(nodes, assignments, functions, options);

  const out: CaptureMatch[] = [];
  for (const assignment of assignments) {
    emitAssignmentFact(assignment, knownCallableNames, valueBindings, options, out);
  }
  for (const fn of functions) emitFormalFacts(fn, options, out);
  for (const node of nodes) {
    if (
      options.callNodeTypes.has(node.type) &&
      (options.isCallNode === undefined || options.isCallNode(node))
    ) {
      emitCallFacts(node, knownCallableNames, valueBindings, options, out);
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
    const destination = assignmentParts(parent, options)[0]?.destination;
    if (destination !== undefined) return bindingIdentifier(destination, options)?.text;
  }
  return undefined;
}

function functionParameters(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): readonly SyntaxNode[] {
  const providerParameters = options.extractFunctionParameters?.(node);
  if (providerParameters !== undefined) return providerParameters;
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
    if (parts.length === 0) continue;
    seen.add(node.id);
    out.push(...parts);
  }
  return out;
}

function buildValueBindingIndex(
  nodes: readonly SyntaxNode[],
  assignments: readonly AssignmentParts[],
  functions: readonly FunctionInfo[],
  options: CallableFlowCaptureOptions,
): ValueBindingIndex {
  const assignmentRegionIdsByName = new Map<string, Set<number>>();
  const formalByOwner = new Map<number | undefined, Set<string>>();
  const signatureByNameAndRegion = new Map<string, Map<number, CallableCaptureSignature>>();
  const add = (
    index: Map<number | undefined, Set<string>>,
    owner: number | undefined,
    name: string,
  ): void => {
    let names = index.get(owner);
    if (names === undefined) {
      names = new Set();
      index.set(owner, names);
    }
    names.add(name);
  };

  for (const assignment of assignments) {
    const destinationNames = new Set<string>();
    const destination = operandSyntax(assignment.destination, options, true);
    if (destination !== undefined) destinationNames.add(destination.name);
    // Member-path destinations (`o->run = handler`) store into the MEMBER's
    // name-cell — the seed fact is keyed on `run`, so the store must be
    // visible under that name too or the member-call invoke gate never sees
    // it (#2522 review, M3 ops-vtable pattern).
    const terminal = terminalIdentifier(assignment.destination, options);
    if (terminal !== undefined) destinationNames.add(terminal.text);
    for (const name of destinationNames) {
      const region = nearestLexicalRegion(assignment.container, options);
      let regionIds = assignmentRegionIdsByName.get(name);
      if (regionIds === undefined) {
        regionIds = new Set();
        assignmentRegionIdsByName.set(name, regionIds);
      }
      regionIds.add(region.id);
      if (options.functionScopedValueBindings === true) {
        const functionOwner = nearestFunctionOwner(assignment.container, options);
        if (functionOwner !== undefined) regionIds.add(functionOwner.id);
      }
    }
  }
  for (const fn of functions) {
    for (const parameter of fn.parameters) {
      const binding = bindingIdentifier(parameter, options);
      if (binding !== undefined) add(formalByOwner, fn.node.id, binding.text);
    }
  }
  for (const node of nodes) {
    if (options.callableSignatureDeclarationNodeTypes?.has(node.type) !== true) continue;
    const binding = bindingIdentifier(node, options);
    const signature = options.expectedSignature?.(node, node);
    if (binding === undefined || signature === undefined) continue;
    // Only callable-typed VARIABLE declarations (`void (*fp)(int);`) create
    // value cells — a plain function/method prototype (`void f(int);`)
    // declares a callee, not a value. A variable declarator interposes a
    // pointer/parenthesized declarator between the declaration and its
    // identifier; a prototype's identifier hangs directly off the function
    // declarator. Indexing prototypes here turned every call to a declared
    // function into an indirect invoke — and, with
    // `emitCanonicalInvokeReference`, minted a free-call reference that
    // bypassed the precise passes' two-phase/ambiguity suppression
    // (#2522 CI: eight cpp resolver tests gained a phantom edge).
    if (!bindingInterposesValueDeclarator(node, binding)) continue;
    const region = nearestLexicalRegion(node, options);
    let byRegion = signatureByNameAndRegion.get(binding.text);
    if (byRegion === undefined) {
      byRegion = new Map();
      signatureByNameAndRegion.set(binding.text, byRegion);
    }
    byRegion.set(region.id, signature);
    if (options.functionScopedValueBindings === true) {
      const functionOwner = nearestFunctionOwner(node, options);
      if (functionOwner !== undefined) byRegion.set(functionOwner.id, signature);
    }
  }
  return { assignmentRegionIdsByName, formalByOwner, signatureByNameAndRegion };
}

/** True when a pointer/parenthesized declarator sits between the declaration
 *  and its binding identifier — the shape of a callable-typed variable, never
 *  of a plain prototype. Only C/C++ supply signature-declaration node types,
 *  so the type-name sniff stays scoped to those grammars. */
function bindingInterposesValueDeclarator(declaration: SyntaxNode, binding: SyntaxNode): boolean {
  let node: SyntaxNode | null = binding.parent;
  while (node !== null && node.id !== declaration.id) {
    if (node.type.includes('pointer') || node.type.includes('parenthesized')) return true;
    node = node.parent;
  }
  return false;
}

function nearestFunctionOwner(
  input: SyntaxNode,
  options: CallableFlowCaptureOptions,
): SyntaxNode | undefined {
  const providerOwner = options.lexicalFunctionOwner?.(input);
  if (providerOwner !== undefined) return providerOwner;
  let node: SyntaxNode | null = input;
  while (node !== null) {
    if (options.functionNodeTypes.has(node.type)) return node;
    node = node.parent;
  }
  return undefined;
}

function nearestLexicalRegion(input: SyntaxNode, options: CallableFlowCaptureOptions): SyntaxNode {
  const providerOwner = options.lexicalFunctionOwner?.(input);
  let node: SyntaxNode | null = input.parent;
  let outermost = input;
  while (node !== null) {
    outermost = node;
    if (providerOwner !== undefined && node.id === providerOwner.id) return node;
    if (options.functionNodeTypes.has(node.type) || isLexicalRegionNode(node)) return node;
    node = node.parent;
  }
  return providerOwner ?? outermost;
}

function isLexicalRegionNode(node: SyntaxNode): boolean {
  return /(?:^|_)(?:block|body|compound_statement|source_file|program|module|script)(?:$|_)/.test(
    node.type,
  );
}

function isVisibleValueBinding(
  input: SyntaxNode,
  name: string,
  bindings: ValueBindingIndex,
  options: CallableFlowCaptureOptions,
): boolean {
  const assignmentRegionIds = bindings.assignmentRegionIdsByName.get(name);
  const providerOwner = options.lexicalFunctionOwner?.(input);
  if (
    providerOwner !== undefined &&
    (assignmentRegionIds?.has(providerOwner.id) === true ||
      bindings.formalByOwner.get(providerOwner.id)?.has(name) === true)
  ) {
    return true;
  }
  let node: SyntaxNode | null = input;
  while (node !== null) {
    if (assignmentRegionIds?.has(node.id) === true) return true;
    if (
      options.functionNodeTypes.has(node.type) &&
      bindings.formalByOwner.get(node.id)?.has(name) === true
    ) {
      return true;
    }
    node = node.parent;
  }
  if (bindings.formalByOwner.get(undefined)?.has(name) === true) return true;
  // A declared callable-typed binding (file-scope `void (*fp)(int);`) is a
  // value binding wherever its declaration is visible — its assignments may
  // live in OTHER functions (the init/register callback pattern), so
  // assignment regions alone under-approximate visibility and the cross-
  // function call emitted no invoke fact at all (#2522 review, H1).
  return visibleCallableSignature(input, name, bindings, options) !== undefined;
}

function visibleCallableSignature(
  input: SyntaxNode,
  name: string,
  bindings: ValueBindingIndex,
  options: CallableFlowCaptureOptions,
): CallableCaptureSignature | undefined {
  const byRegion = bindings.signatureByNameAndRegion.get(name);
  if (byRegion === undefined) return undefined;
  const providerOwner = options.lexicalFunctionOwner?.(input);
  if (providerOwner !== undefined) {
    const signature = byRegion.get(providerOwner.id);
    if (signature !== undefined) return signature;
  }
  let node: SyntaxNode | null = input;
  while (node !== null) {
    const signature = byRegion.get(node.id);
    if (signature !== undefined) return signature;
    node = node.parent;
  }
  return undefined;
}

function assignmentParts(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): readonly AssignmentParts[] {
  const providerParts = options.extractAssignment?.(node);
  if (providerParts !== undefined) {
    const pairs = Array.isArray(providerParts) ? providerParts : [providerParts];
    return pairs.map((pair) => ({ container: node, ...pair }));
  }
  const destination =
    node.childForFieldName('left') ??
    node.childForFieldName('name') ??
    node.childForFieldName('pattern') ??
    node.childForFieldName('declarator') ??
    node.childForFieldName('target'); // Swift assignment
  const source =
    node.childForFieldName('right') ??
    node.childForFieldName('value') ??
    node.childForFieldName('initializer') ??
    node.childForFieldName('default_value') ??
    node.childForFieldName('result'); // Swift assignment

  // Declaration wrappers often contain the real initialized declarator one
  // level below (for example a declarator list).
  if (destination === null || source === null) {
    for (const child of node.namedChildren) {
      if (child === null || child.id === node.id) continue;
      if (!options.bindingNodeTypes.has(child.type)) continue;
      const nested = assignmentParts(child, options);
      if (nested.length > 0) return nested;
    }
  }
  if (destination === null || source === null) return [];
  return [{ container: node, destination, source }];
}

function emitAssignmentFact(
  assignment: AssignmentParts,
  knownCallableNames: ReadonlySet<string>,
  valueBindings: ValueBindingIndex,
  options: CallableFlowCaptureOptions,
  out: CaptureMatch[],
): void {
  const destination = operandSyntax(
    assignment.destination,
    options,
    options.bindingNodeTypes.has(assignment.container.type),
  );
  const source = operandSyntax(assignment.source, options);
  if (destination === undefined || source === undefined) return;

  const signature =
    options.expectedSignature?.(assignment.container, assignment.destination) ??
    visibleCallableSignature(assignment.container, destination.name, valueBindings, options);
  const sourceIsValueBinding = isVisibleValueBinding(
    assignment.source,
    source.name,
    valueBindings,
    options,
  );
  if (
    options.bareNamesAreCalls === true &&
    source.directDesignator &&
    !source.callableReference &&
    !source.anonymousCallable &&
    !sourceIsValueBinding
  ) {
    // The RHS is the produced value of a call, not a reference to the callee.
    return;
  }
  const sourceIsKnownCallable =
    source.callableReference ||
    source.anonymousCallable ||
    (source.directDesignator &&
      !sourceIsValueBinding &&
      (knownCallableNames.has(source.name) ||
        source.qualifiedName !== undefined ||
        signature !== undefined));
  const flowSource = sourceIsKnownCallable ? asCallableDesignator(source) : source;

  // A call/constructor/composite result is not the function designator that
  // appears inside it. This guard must precede the store path: otherwise
  // `*slot = factory()` stores `factory` itself into `slot`.
  if (
    !source.directDesignator &&
    !sourceIsKnownCallable &&
    source.indirection === 0 &&
    !source.addressOf
  ) {
    return;
  }

  if (destination.indirection > 0) {
    out.push(
      binaryFact('store', assignment.container, 'pointer', destination, 'source', flowSource),
    );
    return;
  }
  if (source.addressOf && !sourceIsKnownCallable) {
    // An address of a value binding creates an abstract-cell edge. Addresses
    // of named callables are seeds instead (function designator semantics).
    if (sourceIsValueBinding) {
      out.push(
        binaryFact('address', assignment.container, 'destination', destination, 'source', source),
      );
    } else if (source.directDesignator) {
      // A declaration imported from another file is only visible after scope
      // finalization. Preserve both interpretations here: the address relation
      // supports pointer-to-pointer cells, while the copy lets the solver's
      // exact lexical/import lookup recognize `auto fp = &importedTarget`.
      out.push(
        binaryFact('address', assignment.container, 'destination', destination, 'source', source),
      );
      out.push(
        binaryFact('copy', assignment.container, 'destination', destination, 'source', source),
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
      '@callable-flow.target': operandCapture('@callable-flow.target', flowSource),
      '@callable-flow.target-name': syntheticCapture(
        '@callable-flow.target-name',
        flowSource.node,
        flowSource.anonymousCallable ? destination.name : flowSource.name,
      ),
    };
    if (flowSource.qualifiedName !== undefined) {
      match['@callable-flow.target-qualified-name'] = syntheticCapture(
        '@callable-flow.target-qualified-name',
        flowSource.node,
        options.normalizeQualifiedName?.(flowSource.qualifiedName) ?? flowSource.qualifiedName,
      );
    }
    addSignatureCaptures(match, assignment.container, signature);
    out.push(match);
    return;
  }

  const kind = options.isTrueReferenceBinding?.(assignment.container, assignment.destination)
    ? 'alias'
    : 'copy';
  out.push(
    binaryFact(kind, assignment.container, 'destination', destination, 'source', flowSource),
  );
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
    addSignatureCaptures(match, parameter, options.expectedSignature?.(parameter, parameter));
    out.push(match);
  }
}

function emitCallFacts(
  call: SyntaxNode,
  knownCallableNames: ReadonlySet<string>,
  valueBindings: ValueBindingIndex,
  options: CallableFlowCaptureOptions,
  out: CaptureMatch[],
): void {
  const calleeNode =
    options.extractCallCallee?.(call) ??
    call.childForFieldName('function') ??
    call.childForFieldName('callee') ??
    call.childForFieldName('name') ??
    call.childForFieldName('method') ??
    call.firstNamedChild;
  if (calleeNode === null) return;

  const callSite = options.callSiteNode?.(call) ?? call;
  const args = callArguments(call, options);
  const member = directCallMemberParts(call, options) ?? memberParts(calleeNode, options);
  const callee = operandSyntax(calleeNode, options);
  const calleeIsValueBinding =
    callee !== undefined && isVisibleValueBinding(call, callee.name, valueBindings, options);
  const directCalleeName =
    member === undefined &&
    callee !== undefined &&
    callee.indirection === 0 &&
    !calleeIsValueBinding
      ? callee.name
      : undefined;
  for (let index = 0; index < args.length; index++) {
    const rawSource = operandSyntax(args[index]!, options);
    if (rawSource === undefined) continue;
    // A call/constructor/composite result is a produced value, not a reference
    // to the terminal identifier inside the expression.
    if (!rawSource.directDesignator && rawSource.indirection === 0 && !rawSource.addressOf) {
      continue;
    }
    const sourceIsValueBinding = isVisibleValueBinding(
      args[index]!,
      rawSource.name,
      valueBindings,
      options,
    );
    if (
      options.bareNamesAreCalls === true &&
      rawSource.directDesignator &&
      !rawSource.callableReference &&
      !rawSource.anonymousCallable &&
      !sourceIsValueBinding
    ) {
      // Bare argument name = a call's produced value in this language.
      continue;
    }
    const sourceIsKnownCallable =
      rawSource.callableReference ||
      rawSource.anonymousCallable ||
      (rawSource.directDesignator &&
        !sourceIsValueBinding &&
        (knownCallableNames.has(rawSource.name) || rawSource.qualifiedName !== undefined));
    // Keep unresolved direct identifiers (not arbitrary expressions): imports
    // and cross-file callable bindings are only known after registry finalize.
    // The solver requires an exact callable lexical binding before propagating,
    // so ordinary value arguments remain inert.
    if (
      !sourceIsValueBinding &&
      !sourceIsKnownCallable &&
      !rawSource.directDesignator &&
      !rawSource.addressOf
    ) {
      continue;
    }
    const source = sourceIsKnownCallable ? asCallableDesignator(rawSource) : rawSource;
    out.push({
      '@callable-flow.argument': nodeToCapture('@callable-flow.argument', callSite),
      '@callable-flow.source': operandCapture('@callable-flow.source', source),
      ...operandMetadataCaptures('source', source),
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
      ...(directCalleeName !== undefined
        ? {
            '@callable-flow.direct-callee-name': syntheticCapture(
              '@callable-flow.direct-callee-name',
              callee!.node,
              directCalleeName,
            ),
          }
        : {}),
    });
  }

  if (member !== undefined) {
    if (
      member.operator !== undefined &&
      options.memberPointerOperators?.has(member.operator) === true
    ) {
      emitInvoke(
        callSite,
        member.member,
        'member-pointer',
        args.length,
        out,
        options,
        member.receiver,
      );
      return;
    }
    if (options.callableProtocolMethods?.has(member.member.name) === true) {
      emitInvoke(callSite, member.receiver, 'callable-object', args.length, out, options);
      return;
    }
    // Field-stored callables (`o->run = handler; o->run(1)` — the C ops-vtable
    // pattern): when a visible assignment wrote this member's name-cell, the
    // member call is an indirect invoke through that cell (#2522 review, M3).
    // Gated on the store so plain accessor calls (`map.get(x)`) stay inert;
    // name-keyed field collapse matches the solver's store/load model.
    // ponytail: same-region joins only — cross-function vtable installs need
    // a field-sensitive cell model.
    if (isVisibleValueBinding(call, member.member.name, valueBindings, options)) {
      emitInvoke(callSite, member.member, 'indirect', args.length, out, options, member.receiver);
    }
    return;
  }

  if (callee === undefined) return;
  if (callee.indirection > 0 || calleeIsValueBinding) {
    const invokeCallee =
      !calleeIsValueBinding && knownCallableNames.has(callee.name)
        ? asCallableDesignator(callee)
        : callee;
    emitInvoke(callSite, invokeCallee, 'indirect', args.length, out, options);
  }
}

function emitInvoke(
  call: SyntaxNode,
  callee: OperandSyntax,
  invocationKind: 'indirect' | 'member-pointer' | 'callable-object',
  arity: number,
  out: CaptureMatch[],
  options: CallableFlowCaptureOptions,
  receiver?: OperandSyntax,
): void {
  out.push({
    '@callable-flow.invoke': nodeToCapture('@callable-flow.invoke', call),
    '@callable-flow.callee': operandCapture('@callable-flow.callee', callee),
    ...operandMetadataCaptures('callee', callee),
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
      ? {
          '@callable-flow.receiver': operandCapture('@callable-flow.receiver', receiver),
          ...operandMetadataCaptures('receiver', receiver),
        }
      : {}),
    '@callable-flow.invocation-kind': syntheticCapture(
      '@callable-flow.invocation-kind',
      call,
      invocationKind,
    ),
    '@callable-flow.arity': syntheticCapture('@callable-flow.arity', call, String(arity)),
  });
  if (invocationKind === 'member-pointer' && receiver !== undefined) {
    // Parenthesized member-pointer callees are not matched by the ordinary
    // member-call query shape.
    // Supply the same canonical callsite contract so the shared resolver can
    // exact-join this fact instead of trusting an unanchored/stale side fact.
    out.push({
      '@reference.call.member': nodeToCapture('@reference.call.member', call),
      '@reference.receiver': operandCapture('@reference.receiver', receiver),
      '@reference.name': operandCapture('@reference.name', callee),
      '@reference.arity': syntheticCapture('@reference.arity', call, String(arity)),
    });
  } else if (options.emitCanonicalInvokeReference === true) {
    out.push({
      '@reference.call.free': nodeToCapture('@reference.call.free', call),
      '@reference.name': operandCapture('@reference.name', callee),
      '@reference.arity': syntheticCapture('@reference.arity', call, String(arity)),
    });
  }
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
    findFirstDescendantOfTypes(call, options.parameterListNodeTypes) ??
    null;
  if (list === null) return [];
  if (options.parameterListNodeTypes.has(list.type)) {
    return list.namedChildren.filter(
      (child): child is SyntaxNode => child !== null && child.type !== 'comment',
    );
  }
  return [list];
}

function directCallMemberParts(
  call: SyntaxNode,
  options: CallableFlowCaptureOptions,
):
  | { readonly receiver: OperandSyntax; readonly member: OperandSyntax; readonly operator?: string }
  | undefined {
  const receiverNode = call.childForFieldName('object') ?? call.childForFieldName('receiver');
  const memberNode = call.childForFieldName('method') ?? call.childForFieldName('name');
  if (receiverNode === null || memberNode === null) return undefined;
  const receiver = operandSyntax(receiverNode, options);
  const member = operandSyntax(memberNode, options);
  return receiver === undefined || member === undefined ? undefined : { receiver, member };
}

function memberParts(
  input: SyntaxNode,
  options: CallableFlowCaptureOptions,
):
  | { readonly receiver: OperandSyntax; readonly member: OperandSyntax; readonly operator?: string }
  | undefined {
  const providerParts = options.memberPointerParts?.(input);
  if (providerParts !== undefined) {
    const receiver = operandSyntax(providerParts.receiver, options);
    const member = operandSyntax(providerParts.member, options);
    if (receiver !== undefined && member !== undefined) {
      return { receiver, member, operator: providerParts.operator };
    }
  }
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
  declarationBinding = false,
): OperandSyntax | undefined {
  if (declarationBinding) {
    const binding = bindingIdentifier(input, options);
    if (binding === undefined) return undefined;
    return {
      name: binding.text,
      node: binding,
      indirection: 0,
      addressOf: false,
      directDesignator: false,
      callableReference: false,
      anonymousCallable: false,
      expressionKind: 'binding',
    };
  }
  const providerReference = options.extractCallableReference?.(input);
  if (providerReference !== undefined) {
    return {
      name: providerReference.name,
      node: providerReference.anchor,
      indirection: 0,
      addressOf: false,
      ...(providerReference.qualifiedName !== undefined
        ? { qualifiedName: providerReference.qualifiedName }
        : {}),
      directDesignator: true,
      callableReference: true,
      anonymousCallable: false,
      expressionKind:
        providerReference.qualifiedName === undefined ? 'callable-designator' : 'bound-member',
    };
  }
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
        directDesignator: true,
        callableReference: true,
        anonymousCallable: true,
        expressionKind: 'anonymous-callable',
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
  const singleNameText = node.text.trim().replace(/^[\$@]+/, '');
  const valueProducingExpression = /call|invocation|creation|new_expression|composite_literal/.test(
    node.type,
  );
  return {
    name: id.text,
    node: id,
    indirection,
    addressOf,
    ...(isQualified ? { qualifiedName: node.text } : {}),
    directDesignator:
      options.identifierNodeTypes.has(node.type) ||
      (!isQualified && singleNameText === id.text) ||
      (isQualified && !valueProducingExpression && !/[([{]/.test(node.text)),
    callableReference: options.callableReferenceNodeTypes?.has(node.type) === true,
    anonymousCallable: false,
    expressionKind: isQualified
      ? 'bound-member'
      : options.callableReferenceNodeTypes?.has(node.type) === true
        ? 'callable-designator'
        : 'binding',
  };
}

function asCallableDesignator(operand: OperandSyntax): OperandSyntax {
  if (operand.expressionKind !== 'binding') return operand;
  return { ...operand, expressionKind: 'callable-designator' };
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

/**
 * For a subscript/index expression, the identifier of interest is always in
 * the container operand, never the index: `tbl[i] = h` must bind the cell
 * `tbl` (index-insensitive, Andersen-style), not the index variable `i` —
 * seeding `i` both pollutes a same-named formal and misses the later
 * `tbl[i]()` join (#2522 review). Field names cover the grammars that field
 * their subscript nodes; others keep the generic traversal.
 */
function subscriptBase(node: SyntaxNode): SyntaxNode | null {
  if (node.childForFieldName('index') === null) return null;
  return (
    node.childForFieldName('argument') ?? // C/C++ subscript_expression
    node.childForFieldName('object') ?? // JS/TS subscript_expression
    node.childForFieldName('value') ?? // Python subscript
    node.childForFieldName('operand') ?? // Go index_expression
    node.childForFieldName('array') // Java array_access
  );
}

function bindingIdentifier(
  node: SyntaxNode,
  options: CallableFlowCaptureOptions,
): SyntaxNode | undefined {
  if (options.identifierNodeTypes.has(node.type)) return node;
  const base = subscriptBase(node);
  if (base !== null) return bindingIdentifier(base, options);
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
  const base = subscriptBase(node);
  if (base !== null) return terminalIdentifier(base, options);
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
    ...operandMetadataCaptures(leftRole, left),
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
    ...operandMetadataCaptures(rightRole, right),
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

function operandMetadataCaptures(
  role: 'source' | 'destination' | 'pointer' | 'binding' | 'callee' | 'receiver',
  operand: OperandSyntax,
): Record<string, ReturnType<typeof nodeToCapture>> {
  return {
    [`@callable-flow.${role}-kind`]: syntheticCapture(
      `@callable-flow.${role}-kind`,
      operand.node,
      operand.expressionKind,
    ),
    ...(operand.qualifiedName !== undefined
      ? {
          [`@callable-flow.${role}-qualified-name`]: syntheticCapture(
            `@callable-flow.${role}-qualified-name`,
            operand.node,
            operand.qualifiedName,
          ),
        }
      : {}),
  };
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
  if (signature?.isConst !== undefined) {
    match['@callable-flow.expected-const'] = syntheticCapture(
      '@callable-flow.expected-const',
      anchor,
      String(signature.isConst),
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
