/**
 * Objective-C grammar adapter for the C CFG walk. Methods, blocks, message
 * facts, fast enumeration and exception constructs live here; the CFG/CDG/RD
 * builders and solvers remain unchanged. ARC and implicit monitor release are
 * not explicit AST calls; non-local setjmp/longjmp are not modeled.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import type { TraversalResult } from '../traversal-result.js';
import type { CfgEdgeKind, CfgVisitor } from '../types.js';
import { CCfgWalk, C_CONTROL_FLOW_TYPES } from './c-cpp.js';
import { ObjectiveCHarvester } from './objective-c-harvest.js';
import { fastEnumerationParts, OBJECTIVE_C_FUNCTION_TYPES } from './objective-c-ast.js';

const CONTROL_FLOW_TYPES = new Set([
  ...C_CONTROL_FLOW_TYPES,
  'try_statement',
  'throw_statement',
  'synchronized_statement',
]);
type SeqResult = TraversalResult | null;
const startLine = (node: SyntaxNode) => node.startPosition.row + 1;
const endLine = (node: SyntaxNode) => node.endPosition.row + 1;
interface CleanupContext {
  readonly jumpDepth: number;
  readonly build: () => SeqResult;
}
interface GotoContext {
  readonly block: number;
  readonly cleanups: readonly CleanupContext[];
}

class ObjectiveCCfgWalk extends CCfgWalk {
  private readonly finalizers: CleanupContext[] = [];
  private readonly gotoLabels = new Map<string, GotoContext>();
  private readonly gotoSources = new Map<string, GotoContext[]>();
  private readonly exceptionRouted = new Set<number>();
  private cleanupLabels: ReadonlyMap<string, string> = new Map();

  protected override visitGoto(stmt: SyntaxNode): TraversalResult {
    const block = this.builder.newBlock(startLine(stmt), endLine(stmt), stmt.text);
    const source: GotoContext = { block, cleanups: [...this.finalizers] };
    const name = stmt.childForFieldName('label')?.text;
    const label = name ? (this.cleanupLabels.get(name) ?? name) : undefined;
    const target = label ? this.gotoLabels.get(label) : undefined;
    if (target) this.connectGoto(source, target);
    else if (label) {
      const pending = this.gotoSources.get(label) ?? [];
      pending.push(source);
      this.gotoSources.set(label, pending);
    } else this.connectGoto(source, { block: this.builder.exitIndex, cleanups: [] });
    return { entry: block, exits: [] };
  }

  protected override visitLabeled(stmt: SyntaxNode): SeqResult {
    const result = super.visitLabeled(stmt);
    const name = stmt.childForFieldName('label')?.text;
    const label = name ? (this.cleanupLabels.get(name) ?? name) : undefined;
    const block = name ? this.labelBlocks.get(name) : undefined;
    if (label && block !== undefined) {
      const target: GotoContext = { block, cleanups: [...this.finalizers] };
      this.gotoLabels.set(label, target);
      for (const source of this.gotoSources.get(label) ?? []) this.connectGoto(source, target);
      this.gotoSources.delete(label);
    }
    return result;
  }

  private connectGoto(source: GotoContext, target: GotoContext): void {
    const crossed = source.cleanups
      .filter((cleanup) => !target.cleanups.includes(cleanup))
      .reverse();
    this.builder.connect(this.runCleanups([source.block], crossed), target.block, 'seq');
  }

  /** Each completion gets its own cleanup blocks and therefore its own continuation. */
  private runCleanups(
    exits: readonly number[],
    cleanups: readonly CleanupContext[],
    kind: CfgEdgeKind = 'seq',
  ): number[] {
    let dangling = [...exits];
    for (const cleanup of cleanups) {
      if (!dangling.length) break;
      const result = cleanup.build();
      if (result) {
        this.builder.connect(dangling, result.entry, kind);
        dangling = [...result.exits];
        kind = 'seq';
      }
    }
    return dangling;
  }

  private cleanupContext(body: SyntaxNode): CleanupContext {
    const finalizers = [...this.finalizers];
    const jumps = [...this.jumps];
    const handlers = [...this.handlers];
    const outerLabels = this.cleanupLabels;
    const localLabels: string[] = [];
    const pending = [body];
    while (pending.length) {
      const node = pending.pop()!;
      if (OBJECTIVE_C_FUNCTION_TYPES.has(node.type)) continue;
      const name =
        node.type === 'labeled_statement' ? node.childForFieldName('label')?.text : undefined;
      if (name) localLabels.push(name);
      pending.push(...node.namedChildren);
    }
    return {
      jumpDepth: jumps.length,
      build: () => {
        const activeFinalizers = [...this.finalizers];
        const activeJumps = [...this.jumps];
        const activeHandlers = [...this.handlers];
        const activeLabels = this.cleanupLabels;
        this.finalizers.splice(0, this.finalizers.length, ...finalizers);
        this.jumps.splice(0, this.jumps.length, ...jumps);
        this.handlers.splice(0, this.handlers.length, ...handlers);
        // Only labels declared inside this cleanup are private to the replay;
        // jumps to an enclosing label still leave through the ordinary route.
        const labels = new Map(outerLabels);
        for (const name of localLabels) labels.set(name, `${this.builder.blockCount}:${name}`);
        this.cleanupLabels = labels;
        try {
          const firstBlock = this.builder.blockCount;
          const result = this.visitBody(body);
          // A cleanup exception belongs to the outer context, never the try
          // whose pending completion is being resumed or replaced.
          this.connectExceptions(firstBlock, [this.currentHandler()]);
          return result;
        } finally {
          this.finalizers.splice(0, this.finalizers.length, ...activeFinalizers);
          this.jumps.splice(0, this.jumps.length, ...activeJumps);
          this.handlers.splice(0, this.handlers.length, ...activeHandlers);
          this.cleanupLabels = activeLabels;
        }
      },
    };
  }

  override finishGotos(): void {
    for (const [label, sources] of this.gotoSources) {
      // eslint-disable-next-line no-console -- preserve the CFG builder's unresolved-label diagnostic
      console.warn(
        `[cfg] unresolved goto label "${label}" routed to EXIT (${sources.length} site(s))`,
      );
      for (const source of sources)
        this.connectGoto(source, { block: this.builder.exitIndex, cleanups: [] });
    }
    this.gotoSources.clear();
  }

  private connectExceptions(firstBlock: number, targets: readonly number[]): void {
    for (let block = firstBlock; block < this.builder.blockCount; block++) {
      // A nested try already routes its protected blocks through its own
      // handlers/cleanup. An outer exceptional edge would bypass that finally.
      if (this.exceptionRouted.has(block)) continue;
      for (const target of targets) this.builder.edge(block, target, 'throw');
      this.exceptionRouted.add(block);
    }
  }

  protected override routeJump(
    from: number,
    target: number,
    kind: 'return' | 'break' | 'continue',
  ): void {
    // Loop/switch frames already belong to the C walk. Their depth identifies
    // precisely which finalizers lie between this jump and its target: a loop
    // wholly inside a try must not execute that try's finally on break.
    const targetDepth =
      kind === 'return'
        ? -1
        : this.jumps.findIndex((frame) =>
            kind === 'break'
              ? frame.breakTo === target
              : frame.kind === 'loop' && frame.continueTo === target,
          );
    const crossed = this.finalizers.filter((fin) => fin.jumpDepth > targetDepth).reverse();
    const exits = this.runCleanups([from], crossed, kind);
    this.builder.connect(exits, target, exits[0] === from ? kind : `finally-${kind}`);
  }

  protected override visitFor(stmt: SyntaxNode): TraversalResult {
    const parts = fastEnumerationParts(stmt);
    if (!parts) return super.visitFor(stmt);
    const header = this.builder.newBlock(
      startLine(stmt),
      endLine(parts.collection),
      `for (${stmt.childForFieldName('type')?.text ?? ''} ${parts.declarator.text} in ${parts.collection.text})`,
      'normal',
      this.harvest.forRangeHeadFacts(stmt),
    );
    const exit = this.builder.newBlock(endLine(stmt), endLine(stmt), '');
    this.jumps.push({ kind: 'loop', breakTo: exit, continueTo: header });
    const body = this.visitBody(parts.body);
    this.jumps.pop();
    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else this.builder.edge(header, header, 'loop-back');
    this.builder.edge(header, exit, 'cond-false');
    return { entry: header, exits: [exit] };
  }

  protected override visitExtra(stmt: SyntaxNode): SeqResult | undefined {
    if (stmt.type === 'try_statement') return this.visitTry(stmt);
    if (stmt.type === 'throw_statement') {
      const result = this.visitSimple(stmt);
      this.builder.edge(result.entry, this.currentHandler(), 'throw');
      return { entry: result.entry, exits: [] };
    }
    if (stmt.type === 'synchronized_statement') {
      const body = this.bodyBlockOf(stmt);
      const receiver = stmt.namedChildren.find(
        (child) => child.id !== body?.id && child.type !== 'comment',
      );
      const res = this.visitBody(body);
      if (!receiver) return res;
      const head = this.visitSimple(receiver);
      if (res) this.builder.connect(head.exits, res.entry, 'seq');
      return { entry: head.entry, exits: res?.exits ?? head.exits };
    }
    return undefined;
  }

  private visitTry(stmt: SyntaxNode): SeqResult {
    const catches = stmt.namedChildren.filter((child) => child.type === 'catch_clause');
    const finallyClause = stmt.namedChildren.find((child) => child.type === 'finally_clause');
    const outerHandler = this.currentHandler();
    const cleanupBody = finallyClause ? this.bodyBlockOf(finallyClause) : undefined;
    const cleanup = cleanupBody ? this.cleanupContext(cleanupBody) : undefined;
    const exceptionalCleanup = cleanup?.build();
    if (exceptionalCleanup) this.builder.connect(exceptionalCleanup.exits, outerHandler, 'throw');
    if (cleanup) this.finalizers.push(cleanup);
    const exceptionalTarget = exceptionalCleanup?.entry ?? outerHandler;

    const handlers: TraversalResult[] = [];
    for (const clause of catches) {
      const firstBlock = this.builder.blockCount;
      this.handlers.push(exceptionalTarget);
      let handler = this.visitBody(this.bodyBlockOf(clause));
      this.handlers.pop();
      // Catch bodies can also raise, including without an explicit @throw.
      this.connectExceptions(firstBlock, [exceptionalTarget]);
      if (!handler) {
        const entry = this.builder.newBlock(startLine(clause), endLine(clause), '');
        this.exceptionRouted.add(entry);
        handler = { entry, exits: [entry] };
      }
      const facts = this.harvest.catchParamFacts(clause);
      if (facts) {
        const binding = this.builder.newBlock(
          startLine(clause),
          startLine(clause),
          '',
          'normal',
          facts,
        );
        this.exceptionRouted.add(binding);
        this.builder.edge(binding, handler.entry, 'seq');
        handler = { entry: binding, exits: handler.exits };
      }
      handlers.push(handler);
    }

    const firstProtected = this.builder.blockCount;
    this.handlers.push(handlers[0]?.entry ?? exceptionalTarget);
    let body = this.visitBody(this.bodyBlockOf(stmt));
    this.handlers.pop();
    // Runtime exception matching is uncertain. Preserve every handler and the
    // uncaught path, including exceptions raised inside a branch of the try.
    this.connectExceptions(firstProtected, [
      ...handlers.map((handler) => handler.entry),
      exceptionalTarget,
    ]);
    if (!body) {
      // An empty try completes normally; it must not use a catch as its entry.
      const entry = this.builder.newBlock(startLine(stmt), startLine(stmt), '');
      body = { entry, exits: [entry] };
      this.exceptionRouted.add(entry);
    }
    if (cleanup) this.finalizers.pop();
    const normalExits = [...body.exits, ...handlers.flatMap((handler) => handler.exits)];
    return {
      entry: body.entry,
      exits: cleanup ? this.runCleanups(normalExits, [cleanup]) : normalExits,
    };
  }
}

export function createObjectiveCCfgVisitor(): CfgVisitor<SyntaxNode> {
  return {
    isFunction: (node) => OBJECTIVE_C_FUNCTION_TYPES.has(node.type),
    buildFunctionCfg: (node, filePath) => {
      if (!OBJECTIVE_C_FUNCTION_TYPES.has(node.type)) return undefined;
      const body =
        node.childForFieldName('body') ??
        node.namedChildren.find((child) => child.type === 'compound_statement');
      if (!body) return undefined;
      const builder = new CfgBuilder(
        filePath,
        startLine(node),
        endLine(node),
        node.startPosition.column,
      );
      const harvest = new ObjectiveCHarvester(node);
      const params = harvest.paramFacts();
      if (params) builder.attachFacts(builder.entryIndex, params);
      const walk = new ObjectiveCCfgWalk(builder, harvest, CONTROL_FLOW_TYPES);
      const res = walk.visitSeq(body.namedChildren.filter((child) => child.type !== 'comment'));
      walk.finishGotos();
      builder.edge(builder.entryIndex, res?.entry ?? builder.exitIndex, 'seq');
      if (res) builder.connect(res.exits, builder.exitIndex, 'seq');
      return builder.finish(harvest.bindingTable());
    },
  };
}
