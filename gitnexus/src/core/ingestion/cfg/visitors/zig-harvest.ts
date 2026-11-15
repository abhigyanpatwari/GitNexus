/**
 * Zig lexical def/use and call-site facts for the existing generic PDG solvers.
 * ScopeTreeHarvester owns resolution; only grammar decisions live here. Payloads
 * belong to their selected arm, `_` is discarded, and containers/functions are
 * opaque. Member/index stores read the receiver, never kill its scalar binding.
 *
 * A control-flow-valued expression is evaluated in its own blocks, so its result
 * must be carried to whatever consumes it. A {@link ZigResultSink} names the
 * bindings every normal-result leaf defines: the assignment's own identifier
 * targets when the expression is the whole value, otherwise a provider-owned
 * temporary (`$resultN`) that the consuming statement reads. Evaluation facts and
 * call sites are harvested once, at the leaf; a payload reads the uses of the
 * expression it captures from.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';
import { ScopeTreeHarvester, type Scope, type FactAccumulator } from './scope-tree-harvest.js';
import { CallSiteFactAccumulator, finalizeChain } from './call-site-harvest.js';
import {
  ZIG_OPAQUE,
  zigAssignment,
  zigChildren,
  zigConditional,
  zigJumpValue,
  zigPayload,
} from './zig-ast.js';

/** Bindings every normal-result leaf of a control-flow-valued expression defines. */
export interface ZigResultSink {
  readonly defs: readonly number[];
  /** Bindings the leaf also reads first (a compound assignment's own target). */
  readonly uses: readonly number[];
}

/** Control-flow child expression id -> the binding its result is carried in. */
export type ZigResultCarriers = ReadonlyMap<number, number>;

const NO_CARRIERS: ZigResultCarriers = new Map();

/** The call a value is exactly, seen through parentheses and `try`. */
function resultCall(value: SyntaxNode): SyntaxNode | undefined {
  let call: SyntaxNode | undefined = value;
  while (call && (call.type === 'parenthesized_expression' || call.type === 'try_expression'))
    call = call.namedChildren[0];
  return call && (call.type === 'call_expression' || call.type === 'builtin_function')
    ? call
    : undefined;
}

export class ZigHarvester extends ScopeTreeHarvester {
  private resultTemps = 0;

  constructor(fn: SyntaxNode) {
    super(fn);
    const params = fn.namedChildren.find((c) => c.type === 'parameters');
    for (const [formalIndex, param] of (
      params?.namedChildren.filter((c) => c.type === 'parameter') ?? []
    ).entries()) {
      const name = param.childForFieldName('name');
      if (!name || name.text === '_') continue;
      this.declare(name, 'param', this.root);
      const idx = this.root.table.get(name.text)!;
      this.bindings[idx] = { ...this.bindings[idx], formalIndex };
    }
    const body = fn.childForFieldName('body');
    if (body) this.prescan(body, this.root);
  }

  protected override declare(node: SyntaxNode, kind: BindingEntry['kind'], scope: Scope): void {
    if (node.text !== '_') super.declare(node, kind, scope);
  }

  private scanArm(
    body: SyntaxNode | undefined,
    payload: SyntaxNode | undefined,
    outer: Scope,
  ): void {
    if (!body) return;
    const scope: Scope = { parent: outer, table: new Map() };
    this.scopeByNode.set(body.id, scope);
    if (payload) {
      this.nearestScopeCache.set(payload.id, scope);
      for (const name of payload.namedChildren) {
        this.declare(name, 'let', scope);
        this.nearestScopeCache.set(name.id, scope);
      }
    }
    this.prescan(body, scope);
  }

  protected prescan(node: SyntaxNode, scope: Scope): void {
    if (ZIG_OPAQUE.has(node.type)) return;
    if (node.type === 'block') {
      scope = this.scopeByNode.get(node.id) ?? { parent: scope, table: new Map() };
      this.scopeByNode.set(node.id, scope);
    }
    this.nearestScopeCache.set(node.id, scope);
    if (/^(if|while|for)_(statement|expression|type_expression)$/.test(node.type)) {
      const parts = zigConditional(node);
      for (const input of parts.inputs) this.prescan(input, scope);
      this.scanArm(parts.body, parts.payload, scope);
      if (parts.update)
        this.prescan(parts.update, this.scopeByNode.get(parts.body?.id ?? -1) ?? scope);
      this.scanArm(parts.alternative, parts.elsePayload, scope);
      return;
    }
    if (node.type === 'catch_expression') {
      this.prescan(zigChildren(node)[0], scope);
      this.scanArm(zigChildren(node).at(-1), zigPayload(node), scope);
      return;
    }
    if (node.type === 'switch_case' || node.type === 'errdefer_statement') {
      const body = zigChildren(node).at(-1);
      for (const child of zigChildren(node)) {
        if (child.id !== body?.id && child.type !== 'payload') this.prescan(child, scope);
      }
      this.scanArm(body, zigPayload(node), scope);
      return;
    }
    if (node.type === 'variable_declaration') {
      const targets = zigAssignment(node).targets;
      for (const target of targets) {
        let previous = target.previousSibling;
        while (previous?.type === 'comment') previous = previous.previousSibling;
        if (
          target.type === 'identifier' &&
          (previous?.type === 'const' || previous?.type === 'var')
        ) {
          this.declare(target, previous.type === 'const' ? 'const' : 'var', scope);
        }
      }
    }
    for (const child of zigChildren(node)) this.prescan(child, scope);
  }

  params(): StatementFacts {
    return {
      line: this.fnNode.startPosition.row + 1,
      defs: this.bindings.flatMap((b, i) => (b.kind === 'param' ? [i] : [])),
      uses: [],
    };
  }

  /**
   * A capture's definitions. The captured value comes from `subjects` (the
   * condition, switch operand or error source it unwraps) and `operand` (a
   * carrier bound to that operand), so the capture depends on what it unwraps.
   * Subject calls are not re-recorded: they were harvested where evaluated.
   */
  payload(
    node: SyntaxNode,
    subjects: readonly SyntaxNode[] = [],
    operand: readonly number[] = [],
  ): StatementFacts {
    const acc = new CallSiteFactAccumulator(node.startPosition.row + 1);
    for (const subject of subjects)
      for (const use of this.facts(subject).uses) acc.addUseWithoutOccurrence(use);
    for (const use of operand) acc.addUseWithoutOccurrence(use);
    for (const name of node.namedChildren) if (name.text !== '_') this.def(name, acc);
    return acc.finish();
  }

  /**
   * Facts for `node`. `carriers` replaces control-flow children that were
   * evaluated in their own blocks with a read of the binding carrying their
   * result. `sink` makes `node` a result leaf: it additionally defines the sink's
   * bindings, and a call that is exactly its value records them as its result.
   */
  facts(
    node: SyntaxNode,
    carriers: ZigResultCarriers = NO_CARRIERS,
    sink?: ZigResultSink,
  ): StatementFacts {
    const acc = new CallSiteFactAccumulator(node.startPosition.row + 1);
    if (sink) {
      const value = node.type === 'break_expression' ? zigJumpValue(node) : node;
      const call = value && resultCall(value);
      if (call && sink.defs.length) this.resultDefTargets.set(call.id, [...sink.defs]);
    }
    this.walk(node, acc, carriers);
    if (sink) {
      for (const use of sink.uses) acc.addUse(use);
      for (const def of sink.defs) acc.addDef(def);
    }
    return acc.finish();
  }

  /**
   * The destination of an assignment/declaration whose targets are all plain
   * identifiers, or undefined for a member/index/dereference store (whose receiver
   * reads belong to the consuming statement, not to each result leaf).
   */
  assignmentSink(node: SyntaxNode): ZigResultSink | undefined {
    const { targets, operator } = zigAssignment(node);
    if (!targets.length || targets.some((t) => t.type !== 'identifier')) return undefined;
    const acc = new CallSiteFactAccumulator(node.startPosition.row + 1);
    for (const target of targets) this.target(target, acc, operator !== '=');
    const { defs, uses } = acc.finish();
    return { defs, uses };
  }

  /** A provider-owned binding carrying the result of one control-flow-valued expression. */
  resultTemp(node: SyntaxNode): ZigResultSink {
    this.bindings.push({
      name: `$result${this.resultTemps++}`,
      declLine: node.startPosition.row + 1,
      declColumn: node.startPosition.column,
      kind: 'let',
    });
    return { defs: [this.bindings.length - 1], uses: [] };
  }

  /** Facts-only read of carriers, for a decision that consumes an operand's result. */
  consume(node: SyntaxNode, carriers: readonly number[]): StatementFacts {
    return { line: node.startPosition.row + 1, defs: [], uses: [...carriers] };
  }

  private target(node: SyntaxNode, acc: FactAccumulator, compound: boolean): void {
    if (node.type === 'identifier') {
      if (node.text !== '_') {
        if (compound) this.use(node, acc);
        this.def(node, acc);
      }
    } else this.walk(node, acc, NO_CARRIERS);
  }

  private walk(node: SyntaxNode, acc: FactAccumulator, carriers: ZigResultCarriers): void {
    const carrier = carriers.get(node.id);
    if (carrier !== undefined) {
      acc.addUse(carrier);
      return;
    }
    if (ZIG_OPAQUE.has(node.type)) return;
    switch (node.type) {
      case 'identifier':
        if (node.text !== '_') this.use(node, acc);
        return;
      case 'payload':
      case 'block_label':
      case 'break_label':
      case 'error_type':
      case 'builtin_type':
      case 'string':
      case 'multiline_string':
      case 'comment':
        return;
      case 'variable_declaration':
      case 'assignment_expression': {
        const { targets, value, operator } = zigAssignment(node);
        const defs = acc.defSnapshot();
        for (const target of targets) this.target(target, acc, operator !== '=');
        if (value) {
          const call = resultCall(value);
          if (call) this.resultDefTargets.set(call.id, acc.defsSince(defs));
          this.walk(value, acc, carriers);
        }
        return;
      }
      case 'field_expression': {
        this.chain(node, acc, false, carriers);
        return;
      }
      case 'field_initializer':
        for (const child of zigChildren(node).slice(1)) this.walk(child, acc, carriers);
        return;
      case 'call_expression':
      case 'builtin_function': {
        const site = acc.openCallSite('call', [
          node.startPosition.row + 1,
          node.startPosition.column,
        ]);
        const targets = this.resultDefTargets.get(node.id);
        if (targets?.length) acc.setSiteResultDefs(site, targets);
        acc.pushFrame(site);
        let fn: SyntaxNode | undefined;
        let args: SyntaxNode | undefined;
        if (node.type === 'call_expression') {
          fn = node.childForFieldName('function') ?? undefined;
          args = node.childForFieldName('arguments') ?? undefined;
        } else {
          // Builtins expose children without the call_expression field names.
          fn = node.namedChildren.find((child) => child.type === 'builtin_identifier');
          args = node.namedChildren.find((child) => child.type === 'arguments');
        }
        if (fn?.type === 'identifier' || fn?.type === 'builtin_identifier') {
          acc.setSiteCallee(site, fn.text);
          if (fn.type === 'identifier' && fn.text !== '_')
            acc.addUseWithoutOccurrence(this.resolve(fn));
        } else if (fn) {
          const chain = this.chain(fn, acc, true, carriers);
          if (chain.path) acc.setSiteCallee(site, chain.path);
          if (chain.rootIdx !== undefined) acc.setSiteReceiver(site, chain.rootIdx);
        }
        for (const [i, arg] of (args && !carriers.has(args.id)
          ? zigChildren(args)
          : []
        ).entries()) {
          acc.setFrameArg(i);
          this.walk(arg, acc, carriers);
        }
        acc.popFrame();
        return;
      }
      case 'binary_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left) this.walk(left, acc, carriers);
        if (right) {
          const op = node.childForFieldName('operator')?.text;
          if (op === 'and' || op === 'or' || op === 'orelse')
            this.conditional(() => this.walk(right, acc, carriers));
          else this.walk(right, acc, carriers);
        }
        return;
      }
    }
    const type = node.childForFieldName('type');
    for (const child of zigChildren(node))
      if (child.id !== type?.id) this.walk(child, acc, carriers);
  }

  private chain(
    node: SyntaxNode,
    acc: FactAccumulator,
    skipFinal: boolean,
    carriers: ZigResultCarriers,
  ) {
    let root = node;
    const accesses: string[] = [];
    while (root.type === 'field_expression') {
      const object = root.childForFieldName('object');
      const member = root.childForFieldName('member');
      if (!object) return {}; // enum literals `.tag` are not variable reads.
      accesses.unshift(member?.text ?? '');
      root = object;
    }
    const carrier = carriers.get(root.id);
    if (carrier !== undefined) {
      acc.addUse(carrier);
      return {};
    }
    return finalizeChain(acc, root, accesses, skipFinal, (t) => t === 'identifier', {
      resolve: (n) => this.resolve(n),
      walkRoot: (n) => this.walk(n, acc, carriers),
    });
  }
}
