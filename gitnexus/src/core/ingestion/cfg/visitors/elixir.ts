/**
 * Elixir CFG visitor.  Elixir's `def` clauses are deliberately kept as separate
 * CFGs: the semantic graph coalesces their callable identity, while each clause
 * retains its own guards and control dependencies.
 *
 * This is intentionally structural.  A receive is a local branch (there is no
 * process/message-delivery edge), and anonymous functions are collected as
 * independent closures by `collectFunctionCfgs`.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import type {
  BindingEntry,
  CfgVisitor,
  FunctionCfg,
  SiteRecord,
  StatementFacts,
} from '../types.js';

const FUNCTION_TYPES = new Set(['call', 'anonymous_function']);
const start = (n: SyntaxNode) => n.startPosition.row + 1;
const end = (n: SyntaxNode) => n.endPosition.row + 1;

function isFunction(node: SyntaxNode): boolean {
  if (node.type === 'anonymous_function') return true;
  return node.type === 'call' && /^(def|defp|defmacro|defmacrop)\b/.test(node.text);
}

function bodyOf(node: SyntaxNode): SyntaxNode | undefined {
  const doBlock = node.namedChildren.find((child) => child.type === 'do_block');
  if (doBlock) return doBlock;
  if (node.type === 'anonymous_function')
    return node.namedChildren
      .find((child) => child.type === 'stab_clause')
      ?.namedChildren.find((child) => child.type === 'body');
  // `def f(x), do: expr` has no do_block; its keyword pair is still a distinct
  // clause body and must receive its own CFG.
  return node.namedChildren
    .find((child) => child.type === 'arguments')
    ?.namedChildren.find((child) => child.type === 'keywords')
    ?.namedChildren.find((child) => child.type === 'pair')
    ?.namedChildren.at(-1);
}

/**
 * Small, grammar-shaped fact collector. Elixir represents both `=` matches and
 * guards as `binary_operator`; only the left side of a match introduces a
 * binding. A pinned identifier is deliberately a read. This is kept here
 * rather than borrowing a JS harvester: names and call/member syntax differ.
 */
class ElixirHarvester {
  private readonly bindings: BindingEntry[] = [];
  private readonly byName = new Map<string, number>();

  constructor(fn: SyntaxNode) {
    const args = fn.namedChildren.find((n) => n.type === 'arguments');
    // The `arguments` node for a guarded definition also contains the callable
    // head (`f(...) when guard`); only identifiers physically inside the first
    // parenthesized pattern list are formal bindings.
    const open = fn.text.indexOf('(');
    if (args && open >= 0) {
      const firstParamColumn = fn.startPosition.column + open;
      for (const child of args.namedChildren) {
        if (
          child.startPosition.row === fn.startPosition.row &&
          child.startPosition.column <= firstParamColumn
        )
          continue;
        if (child.type === 'binary_operator' && /\bwhen\b/.test(child.text)) {
          const patternCall = child.namedChildren.find((n) => n.type === 'call');
          const patterns = patternCall?.namedChildren.find((n) => n.type === 'arguments');
          if (patterns)
            for (const name of this.identifiers(patterns)) this.bind(name, patterns, 'param');
        } else for (const name of this.identifiers(child)) this.bind(name, child, 'param');
      }
    }
  }

  private bind(name: string, node: SyntaxNode, kind: BindingEntry['kind'] = 'var'): number {
    const existing = this.byName.get(name);
    if (existing !== undefined) return existing;
    const idx = this.bindings.length;
    this.bindings.push({
      name,
      kind,
      declLine: start(node),
      declColumn: node.startPosition.column,
    });
    this.byName.set(name, idx);
    return idx;
  }

  private read(name: string, node: SyntaxNode): number {
    return this.byName.get(name) ?? this.bind(name, node, 'var');
  }

  private identifiers(node: SyntaxNode): string[] {
    const out: string[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n !== node && isFunction(n)) return;
      if (n.type === 'identifier' && n.text !== '_' && !/^(do|end|when)$/.test(n.text))
        out.push(n.text);
      for (const c of n.namedChildren) walk(c);
    };
    walk(node);
    return out;
  }

  facts(node: SyntaxNode): StatementFacts {
    const defs: number[] = [],
      uses: number[] = [];
    const match =
      node.type === 'binary_operator' &&
      /^\s*(=|<-)\s*$/.test(node.children.find((c) => !c.isNamed)?.text ?? '');
    const left = match ? node.namedChildren[0] : undefined;
    if (left) for (const name of this.identifiers(left)) defs.push(this.bind(name, left));
    for (const name of this.identifiers(node)) {
      if (left && this.identifiers(left).includes(name)) continue;
      uses.push(this.read(name, node));
    }
    const sites: SiteRecord[] = [];
    // Phoenix exposes request input both through conn.params-like fields and
    // directly through the conventional `params["key"]` map argument.  Keep
    // these as member-read facts: the language-neutral taint matcher owns the
    // policy while this visitor only records the syntactic substrate.
    const visitAccesses = (n: SyntaxNode): void => {
      if (n !== node && isFunction(n)) return;
      if (n.type === 'access_call') {
        const root = n.namedChildren[0];
        if (root?.type === 'identifier') {
          sites.push({
            kind: 'member-read',
            object: this.read(root.text, root),
            property: root.text,
          });
        }
      }
      if (n.type === 'call' && n.parent?.type === 'access_call') {
        const dot = n.namedChildren.find((c) => c.type === 'dot');
        const root = dot?.namedChildren[0];
        const property = dot?.namedChildren.at(-1);
        if (root?.type === 'identifier' && property?.type === 'identifier') {
          sites.push({
            kind: 'member-read',
            object: this.read(root.text, root),
            property: property.text,
          });
        }
      }
      for (const c of n.namedChildren) visitAccesses(c);
    };
    visitAccesses(node);
    const visitCalls = (n: SyntaxNode): void => {
      if (n !== node && isFunction(n)) return;
      if (n.type === 'call') {
        const dot = n.namedChildren.find((c) => c.type === 'dot');
        const callee = dot?.text || n.namedChildren.find((c) => c.type === 'identifier')?.text;
        if (
          callee &&
          !/^(if|unless|case|cond|with|try|receive|for|def|defp|defmacro|defmacrop)$/.test(callee)
        ) {
          const argumentsNode = n.namedChildren.find((c) => c.type === 'arguments');
          const args = argumentsNode?.namedChildren.map((arg) => [
            ...new Set(this.identifiers(arg).map((name) => this.read(name, arg))),
          ]);
          sites.push({
            kind: 'call',
            callee,
            ...(args?.some((arg) => arg.length) ? { args } : {}),
            at: [start(n), n.startPosition.column],
          });
        }
      }
      for (const c of n.namedChildren) visitCalls(c);
    };
    visitCalls(node);
    return {
      line: start(node),
      defs: [...new Set(defs)],
      uses: [...new Set(uses)],
      ...(sites.length ? { sites } : {}),
    };
  }

  get all(): readonly BindingEntry[] {
    return this.bindings;
  }
}

function buildFunctionCfg(fn: SyntaxNode, filePath: string): FunctionCfg | undefined {
  if (!isFunction(fn)) return undefined;
  const body = bodyOf(fn);
  if (!body) return undefined;
  const builder = new CfgBuilder(filePath, start(fn), end(fn), fn.startPosition.column);
  const harvest = new ElixirHarvester(fn);
  const statementsOf = (n: SyntaxNode): SyntaxNode[] =>
    n.namedChildren.filter(
      (child) =>
        !['comment', 'else_block', 'rescue_block', 'catch_block', 'after_block'].includes(
          child.type,
        ),
    );
  const block = (node: SyntaxNode) =>
    builder.newBlock(start(node), end(node), node.text, 'normal', harvest.facts(node));
  const keyword = (node: SyntaxNode): string | undefined => {
    if (node.type !== 'call') return undefined;
    const name = node.namedChildren.find((child) => child.type === 'identifier')?.text;
    return name && /^(if|unless|case|cond|with|try|receive|for)$/.test(name) ? name : undefined;
  };
  const clauseBody = (clause: SyntaxNode): SyntaxNode[] =>
    statementsOf(clause.namedChildren.find((child) => child.type === 'body') ?? clause).filter(
      (child) => child.type !== 'arguments',
    );

  const visitSeq = (nodes: readonly SyntaxNode[], incoming: readonly number[]): number[] =>
    builder.withNesting(() => {
      let exits = [...incoming];
      for (const node of nodes) exits = visit(node, exits);
      return exits;
    });
  const visitClauses = (clauses: readonly SyntaxNode[], header: number, join: number): void => {
    let fallback = header;
    for (const clause of clauses) {
      const guard = block(clause);
      builder.edge(fallback, guard, 'cond-false');
      builder.edge(header, guard, 'cond-true');
      const exits = visitSeq(clauseBody(clause), [guard]);
      builder.connect(exits, join, 'seq');
      fallback = guard;
    }
    builder.edge(fallback, join, 'cond-false');
  };
  const visit = (node: SyntaxNode, incoming: readonly number[]): number[] =>
    builder.withNesting(() => {
      const form = keyword(node);
      if (!form && node.type === 'binary_operator' && /\b(and|or)\b|&&|\|\|/.test(node.text)) {
        const control = block(node);
        builder.connect(incoming, control);
        const join = builder.newBlock(end(node), end(node), '', 'normal');
        builder.edge(control, join, 'cond-false');
        builder.edge(control, join, 'cond-true');
        return [join];
      }
      if (!form) {
        const normal = block(node);
        builder.connect(incoming, normal);
        return [normal];
      }
      const header = block(node);
      builder.connect(incoming, header);
      const join = builder.newBlock(end(node), end(node), '', 'normal');
      const doBlock = node.namedChildren.find((child) => child.type === 'do_block');
      const elseBlock = doBlock?.namedChildren.find((child) => child.type === 'else_block');
      const clauses = doBlock?.namedChildren.filter((child) => child.type === 'stab_clause') ?? [];

      if (form === 'case' || form === 'cond' || form === 'receive') {
        visitClauses(clauses, header, join);
        const timeout = doBlock?.namedChildren.find((child) => child.type === 'after_block');
        if (timeout) {
          const timeoutExits = visitSeq(
            timeout.namedChildren
              .filter((child) => child.type === 'stab_clause')
              .flatMap(clauseBody),
            [header],
          );
          builder.connect(timeoutExits, join, 'seq');
        }
        return [join];
      }
      if (form === 'try') {
        const main = visitSeq(statementsOf(doBlock ?? node), [header]);
        builder.connect(main, join, 'seq');
        for (const handler of doBlock?.namedChildren.filter(
          (child) => child.type === 'rescue_block' || child.type === 'catch_block',
        ) ?? []) {
          visitClauses(
            handler.namedChildren.filter((child) => child.type === 'stab_clause'),
            header,
            join,
          );
        }
        const after = doBlock?.namedChildren.find((child) => child.type === 'after_block');
        if (after) {
          const afterExits = visitSeq(statementsOf(after), [join]);
          const afterJoin = builder.newBlock(end(after), end(after), '', 'normal');
          builder.connect(afterExits, afterJoin, 'seq');
          return [afterJoin];
        }
        return [join];
      }
      if (form === 'with' || form === 'for') {
        const argumentsNode = node.namedChildren.find((child) => child.type === 'arguments');
        let generator = header;
        for (const part of argumentsNode?.namedChildren.filter(
          (child) => child.type !== 'keywords',
        ) ?? []) {
          const check = block(part);
          builder.edge(generator, check, 'cond-true');
          builder.edge(generator, join, 'cond-false');
          generator = check;
        }
        const bodyExits = visitSeq(statementsOf(doBlock ?? node), [generator]);
        builder.connect(bodyExits, join, 'seq');
        if (elseBlock)
          visitClauses(
            elseBlock.namedChildren.filter((child) => child.type === 'stab_clause'),
            header,
            join,
          );
        return [join];
      }
      const main = visitSeq(statementsOf(doBlock ?? node), [header]);
      builder.connect(main, join, 'cond-true');
      if (elseBlock) {
        const alternate = visitSeq(statementsOf(elseBlock), [header]);
        builder.connect(alternate, join, 'cond-false');
      } else builder.edge(header, join, 'cond-false');
      return [join];
    });

  // A guarded clause can reject before its body runs. Keep that decision in
  // this clause's CFG instead of merging it with sibling clauses: the semantic
  // graph owns canonical callable identity, while CFG remains clause-local.
  const headGuard = fn.namedChildren
    .find((child) => child.type === 'arguments')
    ?.namedChildren.find(
      (child) => child.type === 'binary_operator' && /\bwhen\b/.test(child.text),
    );
  let entry = builder.entryIndex;
  if (headGuard) {
    const guard = block(headGuard);
    builder.edge(entry, guard, 'cond-true');
    builder.edge(entry, builder.exitIndex, 'cond-false');
    entry = guard;
  }
  const exits = visitSeq(statementsOf(body), [entry]);
  builder.connect(exits, builder.exitIndex, 'seq');
  return builder.finish(harvest.all);
}

export function createElixirCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { isFunction, buildFunctionCfg };
}

export { FUNCTION_TYPES as ELIXIR_FUNCTION_TYPES };
