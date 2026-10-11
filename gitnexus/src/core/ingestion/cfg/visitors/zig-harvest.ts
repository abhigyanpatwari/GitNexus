/**
 * Zig lexical def/use and call-site facts for the existing generic PDG solvers.
 * ScopeTreeHarvester owns resolution; only grammar decisions live here. Payloads
 * belong to their selected arm, `_` is discarded, and containers/functions are
 * opaque. Member/index stores read the receiver, never kill its scalar binding.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { BindingEntry, StatementFacts } from '../types.js';
import { ScopeTreeHarvester, type Scope, type FactAccumulator } from './scope-tree-harvest.js';
import { CallSiteFactAccumulator, finalizeChain } from './call-site-harvest.js';
import { ZIG_OPAQUE, zigAssignment, zigChildren, zigConditional, zigPayload } from './zig-ast.js';

export class ZigHarvester extends ScopeTreeHarvester {
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

  payload(node: SyntaxNode): StatementFacts {
    const acc = new CallSiteFactAccumulator(node.startPosition.row + 1);
    for (const name of node.namedChildren) if (name.text !== '_') this.def(name, acc);
    return acc.finish();
  }

  facts(node: SyntaxNode, excluded: ReadonlySet<number> = new Set()): StatementFacts {
    const acc = new CallSiteFactAccumulator(node.startPosition.row + 1);
    this.walk(node, acc, excluded);
    return acc.finish();
  }

  private target(node: SyntaxNode, acc: FactAccumulator, compound: boolean): void {
    if (node.type === 'identifier') {
      if (node.text !== '_') {
        if (compound) this.use(node, acc);
        this.def(node, acc);
      }
    } else this.walk(node, acc, new Set());
  }

  private walk(node: SyntaxNode, acc: FactAccumulator, excluded: ReadonlySet<number>): void {
    if (excluded.has(node.id) || ZIG_OPAQUE.has(node.type)) return;
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
          let call = value;
          while (call.type === 'parenthesized_expression' || call.type === 'try_expression')
            call = call.namedChildren[0];
          if (call.type === 'call_expression' || call.type === 'builtin_function') {
            this.resultDefTargets.set(call.id, acc.defsSince(defs));
          }
          this.walk(value, acc, excluded);
        }
        return;
      }
      case 'field_expression': {
        this.chain(node, acc, false, excluded);
        return;
      }
      case 'field_initializer':
        for (const child of zigChildren(node).slice(1)) this.walk(child, acc, excluded);
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
          const chain = this.chain(fn, acc, true, excluded);
          if (chain.path) acc.setSiteCallee(site, chain.path);
          if (chain.rootIdx !== undefined) acc.setSiteReceiver(site, chain.rootIdx);
        }
        for (const [i, arg] of (args && !excluded.has(args.id)
          ? zigChildren(args)
          : []
        ).entries()) {
          acc.setFrameArg(i);
          this.walk(arg, acc, excluded);
        }
        acc.popFrame();
        return;
      }
      case 'binary_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left) this.walk(left, acc, excluded);
        if (right) {
          const op = node.childForFieldName('operator')?.text;
          if (op === 'and' || op === 'or' || op === 'orelse')
            this.conditional(() => this.walk(right, acc, excluded));
          else this.walk(right, acc, excluded);
        }
        return;
      }
    }
    const type = node.childForFieldName('type');
    for (const child of zigChildren(node))
      if (child.id !== type?.id) this.walk(child, acc, excluded);
  }

  private chain(
    node: SyntaxNode,
    acc: FactAccumulator,
    skipFinal: boolean,
    excluded: ReadonlySet<number>,
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
    if (excluded.has(root.id)) return {};
    return finalizeChain(acc, root, accesses, skipFinal, (t) => t === 'identifier', {
      resolve: (n) => this.resolve(n),
      walkRoot: (n) => this.walk(n, acc, excluded),
    });
  }
}
