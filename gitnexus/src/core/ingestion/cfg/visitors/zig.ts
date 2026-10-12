/**
 * Zig's provider-owned CFG strategy. The generic builder, CDG and reaching-defs
 * solvers consume its ordinary FunctionCfg; there is no second PDG pipeline.
 * Shapes are checked against the vendored tree-sitter-zig grammar.
 *
 * Cleanup is block-scoped, LIFO and replayed per completion path, so a return
 * cannot leak into another return's continuation. errdefer runs only on error
 * propagation. A return whose error-union value is unknown conservatively has
 * both success/error completions. Calls alone do not throw: Zig errors are values.
 * Loops retain a structural false escape (including `while (true)`) for the
 * shared post-dominator solver. Iteration predicates and operand evaluation order
 * are structural approximations; this is syntax-based analysis, not evaluation.
 * A control expression is split into its own blocks, and its result is carried
 * to the consumer: each normal-result leaf (an if/switch arm, a catch or orelse
 * operand, a `try` value, a labeled block's `break` value) defines the assigned
 * identifiers, or a provider-owned `$resultN` binding that the consuming
 * statement (an argument, `return`, a store, a branch decision) reads. Calls are
 * recorded once, at their leaf; a capture reads the uses of what it unwraps.
 * Invalid syntax, unresolved jumps, asm and suspend/resume are skipped rather
 * than represented as exact straight-line control. Nested containers/functions
 * are opaque; each function declaration is separately collected by the pipeline.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import { ControlFlowContext } from '../control-flow-context.js';
import type { CfgEdgeKind, CfgVisitor, FunctionCfg, StatementFacts } from '../types.js';
import type { TraversalResult } from '../traversal-result.js';
import { ZigHarvester, type ZigResultCarriers, type ZigResultSink } from './zig-harvest.js';
import {
  ZIG_OPAQUE,
  zigAssignment,
  zigChildren,
  zigConditional,
  zigJumpValue,
  zigLabel,
  zigPayload,
} from './zig-ast.js';

type Result = TraversalResult | null;
interface Cleanup {
  node: SyntaxNode;
  errorOnly: boolean;
}
/** What an arm needs from its construct: what it captures from, and where its value goes. */
interface Arm {
  subjects?: readonly SyntaxNode[];
  /** Binding that already carries the captured operand (labeled-switch dispatch). */
  operand?: readonly number[];
  sink?: ZigResultSink;
}
class UnsupportedZigCfg extends Error {}

const CONTROL_TYPES = new Set([
  'block',
  'block_expression',
  'labeled_type_expression',
  'labeled_statement',
  'if_statement',
  'if_expression',
  'if_type_expression',
  'while_statement',
  'while_expression',
  'for_statement',
  'for_expression',
  'switch_expression',
  'return_expression',
  'break_expression',
  'continue_expression',
  'try_expression',
  'catch_expression',
  'defer_statement',
  'errdefer_statement',
  'asm_expression',
  'suspend_statement',
  'resume_expression',
  'unreachable',
]);

class ZigCfgWalk {
  private readonly context = new ControlFlowContext();
  private readonly cleanup: Cleanup[] = [];
  /** Number of already-active defers outside each jump target. */
  private readonly cleanupDepth = new Map<number, number>();
  private readonly controlCache = new Map<number, boolean>();
  private readonly switchContinues: { label: string; target: number; sink: ZigResultSink }[] = [];
  /** Where a `break` to this join block delivers its value (loops, labeled blocks and switches). */
  private readonly resultSinks = new Map<number, ZigResultSink>();

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: ZigHarvester,
    private readonly errorReturn: boolean,
  ) {}

  private block(node: SyntaxNode, facts = this.harvest.facts(node), text = node.text): number {
    return this.builder.newBlock(
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      text,
      'normal',
      facts,
    );
  }

  private empty(node: SyntaxNode): number {
    return this.builder.newBlock(node.endPosition.row + 1, node.endPosition.row + 1, '');
  }

  private append(first: Result, next: Result): Result {
    if (!first) return next;
    if (!next) return first;
    this.builder.connect(first.exits, next.entry);
    return { entry: first.entry, exits: first.exits.length ? next.exits : [] };
  }

  private simple(node: SyntaxNode, facts?: StatementFacts): TraversalResult {
    const entry = this.block(node, facts);
    return { entry, exits: [entry] };
  }

  /** A result leaf: its own evaluation facts, plus the destination its value is delivered to. */
  private leaf(node: SyntaxNode, sink?: ZigResultSink): TraversalResult {
    return this.simple(node, this.harvest.facts(node, undefined, sink));
  }

  private hasControl(node: SyntaxNode): boolean {
    const cached = this.controlCache.get(node.id);
    if (cached !== undefined) return cached;
    const op = node.childForFieldName('operator')?.text;
    const result =
      !ZIG_OPAQUE.has(node.type) &&
      (CONTROL_TYPES.has(node.type) ||
        (node.type === 'binary_expression' && (op === 'and' || op === 'or' || op === 'orelse')) ||
        zigChildren(node).some((c) => this.hasControl(c)));
    this.controlCache.set(node.id, result);
    return result;
  }

  private body(node: SyntaxNode | undefined, payload?: SyntaxNode, arm: Arm = {}): Result {
    let result: Result = payload
      ? this.simple(payload, this.harvest.payload(payload, arm.subjects, arm.operand))
      : null;
    if (node) result = this.append(result, this.visit(node, undefined, arm.sink));
    return result;
  }

  /**
   * Lower control-flow-valued children in source order, each into its own result
   * carrier, for a consumer that reads `carriers` instead of re-walking them.
   */
  private evaluate(controls: readonly SyntaxNode[]): {
    result: Result;
    carriers: ZigResultCarriers;
  } {
    let result: Result = null;
    const carriers = new Map<number, number>();
    for (const control of controls) {
      const carrier = this.harvest.resultTemp(control);
      carriers.set(control.id, carrier.defs[0]);
      result = this.append(result, this.visit(control, undefined, carrier));
    }
    return { result, carriers };
  }

  /**
   * Evaluate the operand a branch, loop or dispatch decides on. A control-flow
   * operand's result is read at its join, so the decision depends on it.
   */
  private operand(node: SyntaxNode): Result {
    if (!this.hasControl(node)) return this.visit(node);
    const carrier = this.harvest.resultTemp(node);
    const evaluated = this.visit(node, undefined, carrier);
    return evaluated && this.decide(evaluated, node, carrier.defs);
  }

  /** Attach the read of `carriers` to the single point where the operand's paths join. */
  private decide(
    evaluated: TraversalResult,
    node: SyntaxNode,
    carriers: readonly number[],
  ): TraversalResult {
    if (!evaluated.exits.length) return evaluated;
    let at = evaluated.exits[0];
    if (evaluated.exits.length > 1) {
      at = this.empty(node);
      this.builder.connect(evaluated.exits, at);
    }
    this.builder.attachFacts(at, this.harvest.consume(node, carriers));
    return { entry: evaluated.entry, exits: [at] };
  }

  /** Replay only the cleanup scopes crossed by this completion. */
  private clean(
    exits: readonly number[],
    depth: number,
    error: boolean,
    firstKind: CfgEdgeKind = 'seq',
  ): number[] {
    let dangling = [...exits];
    const active = [...this.cleanup];
    for (let i = active.length - 1; i >= depth && dangling.length; i--) {
      const deferred = active[i];
      if (deferred.errorOnly && !error) continue;
      this.cleanup.length = i;
      const payload = deferred.errorOnly ? zigPayload(deferred.node) : undefined;
      const result = this.body(zigChildren(deferred.node).at(-1), payload);
      if (result) {
        this.builder.connect(dangling, result.entry, firstKind);
        dangling = [...result.exits];
        firstKind = 'seq';
      }
    }
    this.cleanup.splice(0, this.cleanup.length, ...active);
    return dangling;
  }

  private complete(
    from: number,
    target: number,
    kind: 'return' | 'break' | 'continue' | 'throw',
    error = false,
  ): void {
    const depth = this.cleanupDepth.get(target) ?? 0;
    const exits = this.clean([from], depth, error, kind);
    const completion: CfgEdgeKind = kind === 'throw' ? 'throw' : `finally-${kind}`;
    this.builder.connect(exits, target, exits[0] === from ? kind : completion);
  }

  private sequence(node: SyntaxNode): Result {
    const depth = this.cleanup.length;
    let result: Result = null;
    for (const child of zigChildren(node)) {
      // Dead tails must not register a defer for an earlier jump.
      if (result && !result.exits.length) break;
      if (child.type === 'defer_statement' || child.type === 'errdefer_statement') {
        this.cleanup.push({ node: child, errorOnly: child.type === 'errdefer_statement' });
      } else result = this.append(result, this.visit(child));
    }
    if (!result && this.cleanup.length > depth) {
      const entry = this.empty(node);
      result = { entry, exits: [entry] };
    }
    if (result) result = { entry: result.entry, exits: this.clean(result.exits, depth, false) };
    this.cleanup.length = depth;
    return result;
  }

  visit(node: SyntaxNode, label?: string, sink?: ZigResultSink): Result {
    return this.builder.withNesting(() => this.visitNode(node, label, sink));
  }

  /** `sink`: the bindings this expression's normal-result leaves must define. */
  private visitNode(node: SyntaxNode, label?: string, sink?: ZigResultSink): Result {
    if (ZIG_OPAQUE.has(node.type)) return this.leaf(node, sink);
    switch (node.type) {
      case 'asm_expression':
      case 'suspend_statement':
      case 'resume_expression':
        throw new UnsupportedZigCfg();
      case 'unreachable': {
        const entry = this.block(node);
        this.builder.edge(entry, this.builder.exitIndex, 'throw');
        return { entry, exits: [] };
      }
      case 'block': {
        if (!label) return this.sequence(node);
        const join = this.empty(node);
        this.cleanupDepth.set(join, this.cleanup.length);
        if (sink) this.resultSinks.set(join, sink);
        this.context.pushLabeledBlock(join, [label]);
        const body = this.sequence(node);
        this.context.pop();
        if (body) this.builder.connect(body.exits, join);
        return { entry: body?.entry ?? join, exits: [join] };
      }
      case 'block_expression':
      case 'labeled_type_expression':
      case 'labeled_statement':
        return this.visit(
          zigChildren(node).filter((c) => c.type !== 'block_label')[0],
          zigLabel(node) ?? label,
          sink,
        );
      case 'expression_statement':
      case 'comptime_statement':
      case 'nosuspend_statement':
        if (zigChildren(node)[0] && this.hasControl(zigChildren(node)[0]))
          return this.visit(zigChildren(node)[0], label, sink);
        return this.leaf(node, sink);
      case 'if_statement':
      case 'if_expression':
      case 'if_type_expression':
        return this.branch(node, sink);
      case 'while_statement':
      case 'while_expression':
      case 'for_statement':
      case 'for_expression':
        return this.loop(node, zigLabel(node) ?? label, sink);
      case 'switch_expression':
        return this.switch(node, sink);
      case 'return_expression':
      case 'break_expression':
      case 'continue_expression':
        return this.jump(node);
      case 'try_expression': {
        // The value's leaves define the destination before the throw edge leaves
        // them: a cleanup reading a pre-declared destination on the error path sees
        // one conservative extra definition (never a missing one).
        const value = zigChildren(node)[0];
        const result = this.hasControl(value)
          ? this.visit(value, undefined, sink)
          : this.leaf(node, sink);
        if (result)
          for (const from of result.exits)
            this.complete(from, this.builder.exitIndex, 'throw', true);
        return result;
      }
      case 'catch_expression':
        return this.catch(node, sink);
      case 'defer_statement':
      case 'errdefer_statement':
        // The grammar permits these only as statements in a lexical block.
        throw new UnsupportedZigCfg();
      case 'binary_expression': {
        const op = node.childForFieldName('operator')?.text;
        if (op === 'and' || op === 'or' || op === 'orelse') {
          const left = this.visit(node.childForFieldName('left')!, undefined, sink);
          const right = this.visit(node.childForFieldName('right')!, undefined, sink);
          const join = this.empty(node);
          const evaluateRight = op === 'and' ? 'cond-true' : 'cond-false';
          if (left) {
            this.builder.connect(left.exits, right?.entry ?? join, evaluateRight);
            this.builder.connect(
              left.exits,
              join,
              evaluateRight === 'cond-true' ? 'cond-false' : 'cond-true',
            );
          }
          if (right) this.builder.connect(right.exits, join);
          return { entry: left?.entry ?? join, exits: [join] };
        }
        break;
      }
      case 'variable_declaration':
      case 'assignment_expression': {
        const value = zigAssignment(node).value;
        if (!value || !this.hasControl(value)) break;
        // Identifier targets are defined by each normal-result leaf of the value,
        // and only on its successful continuation.
        const destination = this.harvest.assignmentSink(node);
        if (destination) return this.visit(value, undefined, destination) ?? this.simple(node);
        // A store reads its receiver once, after the value is carried to it.
        const { result, carriers } = this.evaluate([value]);
        return this.append(result, this.simple(node, this.harvest.facts(node, carriers)));
      }
    }
    const controls = zigChildren(node)
      .flatMap((c) => (c.type === 'arguments' ? zigChildren(c) : [c]))
      .filter((c) => this.hasControl(c));
    if (!controls.length) return this.leaf(node, sink);
    const { result, carriers } = this.evaluate(controls);
    return this.append(result, this.simple(node, this.harvest.facts(node, carriers, sink)));
  }

  private branch(node: SyntaxNode, sink?: ZigResultSink): Result {
    const { inputs, body, payload, alternative, elsePayload } = zigConditional(node);
    if (!inputs.length || !body) throw new UnsupportedZigCfg();
    const condition = this.operand(inputs[0])!;
    const yes = this.body(body, payload, { subjects: inputs, sink });
    const no = this.body(alternative, elsePayload, { subjects: inputs, sink });
    const join = this.empty(node);
    this.builder.connect(condition.exits, yes?.entry ?? join, 'cond-true');
    this.builder.connect(condition.exits, no?.entry ?? join, 'cond-false');
    if (yes) this.builder.connect(yes.exits, join);
    if (no) this.builder.connect(no.exits, join);
    return {
      entry: condition.entry,
      exits: !yes || yes.exits.length || !no || no.exits.length ? [join] : [],
    };
  }

  private loop(node: SyntaxNode, label?: string, sink?: ZigResultSink): Result {
    const { inputs, body, payload, alternative, elsePayload, update } = zigConditional(node);
    if (!body) throw new UnsupportedZigCfg();
    let evaluated: Result = null;
    for (const input of inputs) evaluated = this.append(evaluated, this.operand(input));
    const isFor = node.type === 'for_statement' || node.type === 'for_expression';
    let condition = evaluated;
    if (isFor) {
      const header = this.empty(node);
      if (evaluated) this.builder.connect(evaluated.exits, header);
      condition = { entry: header, exits: [header] };
    }
    if (!condition)
      condition = this.simple(node, { line: node.startPosition.row + 1, defs: [], uses: [] });
    const join = this.empty(node);
    this.cleanupDepth.set(join, this.cleanup.length);
    // A loop expression's value is a `break` operand, or its `else` arm.
    if (sink) this.resultSinks.set(join, sink);
    let step: Result = null;
    if (update) {
      // The continuation is inside the loop: its breaks must see this exit,
      // including cleanup registered by a block-valued continuation.
      const updateEntry = this.empty(update);
      this.cleanupDepth.set(updateEntry, this.cleanup.length);
      this.context.pushLoop(updateEntry, join, label ? [label] : []);
      step = this.visit(update);
      this.context.pop();
      this.builder.edge(updateEntry, step?.entry ?? condition.entry, 'seq');
    }
    const continueTo = step?.entry ?? condition.entry;
    this.cleanupDepth.set(continueTo, this.cleanup.length);
    this.context.pushLoop(continueTo, join, label ? [label] : []);
    const loopBody = this.body(body, payload, { subjects: inputs });
    this.context.pop();
    const no = this.body(alternative, elsePayload, { subjects: inputs, sink });
    this.builder.connect(condition.exits, loopBody?.entry ?? continueTo, 'cond-true');
    this.builder.connect(condition.exits, no?.entry ?? join, 'cond-false');
    if (loopBody) this.builder.connect(loopBody.exits, continueTo, 'loop-back');
    if (step) this.builder.connect(step.exits, condition.entry, 'loop-back');
    if (no) this.builder.connect(no.exits, join);
    return { entry: evaluated?.entry ?? condition.entry, exits: [join] };
  }

  private switch(node: SyntaxNode, sink?: ZigResultSink): Result {
    const children = zigChildren(node);
    const value = children.find((c) => c.type !== 'block_label' && c.type !== 'switch_case');
    if (!value) throw new UnsupportedZigCfg();
    const label = zigLabel(node);
    // `continue :label next` re-dispatches on `next`: the operand and every
    // continue value are delivered to one carrier that the dispatch reads.
    const carrier = label ? this.harvest.resultTemp(value) : undefined;
    const initial = (carrier ? this.visit(value, undefined, carrier) : this.operand(value))!;
    const join = this.empty(node);
    let dispatch = initial;
    if (carrier) {
      const header = this.block(value, this.harvest.consume(value, carrier.defs));
      this.builder.connect(initial.exits, header);
      dispatch = { entry: header, exits: [header] };
    }
    this.cleanupDepth.set(join, this.cleanup.length);
    this.cleanupDepth.set(dispatch.entry, this.cleanup.length);
    // Zig switches accept only labeled exits. Bare break/continue belongs to
    // the enclosing loop, including when this switch happens to have a label.
    if (label && carrier) {
      if (sink) this.resultSinks.set(join, sink);
      this.context.pushLabeledBlock(join, [label]);
      this.switchContinues.push({ label, target: dispatch.entry, sink: carrier });
    }
    let normal = false;
    for (const arm of children.filter((c) => c.type === 'switch_case')) {
      const result = this.body(zigChildren(arm).at(-1), zigPayload(arm), {
        subjects: [value],
        operand: carrier?.defs,
        sink,
      });
      this.builder.connect(dispatch.exits, result?.entry ?? join, 'switch-case');
      if (result) this.builder.connect(result.exits, join);
      if (!result || result.exits.length) normal = true;
    }
    if (label) {
      this.context.pop();
      this.switchContinues.pop();
    }
    // Exhaustiveness is type-dependent; retain an unknown unmatched-value escape.
    if (
      !children.some((c) => c.type === 'switch_case' && c.children.some((t) => t.type === 'else'))
    ) {
      this.builder.connect(dispatch.exits, join, 'cond-false');
      normal = true;
    }
    return { entry: initial.entry, exits: normal || label ? [join] : [] };
  }

  private catch(node: SyntaxNode, sink?: ZigResultSink): Result {
    const source = this.visit(zigChildren(node)[0], undefined, sink)!;
    const handler = this.body(zigChildren(node).at(-1), zigPayload(node), {
      subjects: [zigChildren(node)[0]],
      sink,
    });
    const join = this.empty(node);
    this.builder.connect(source.exits, join, 'cond-true');
    this.builder.connect(source.exits, handler?.entry ?? join, 'cond-false');
    if (handler) this.builder.connect(handler.exits, join);
    return { entry: source.entry, exits: [join] };
  }

  private jump(node: SyntaxNode): Result {
    const kind =
      node.type === 'return_expression'
        ? 'return'
        : node.type === 'break_expression'
          ? 'break'
          : 'continue';
    const value = zigJumpValue(node);
    const label = zigLabel(node);
    let switchEntry: (typeof this.switchContinues)[number] | undefined;
    if (label)
      for (let i = this.switchContinues.length - 1; i >= 0; i--) {
        if (this.switchContinues[i].label === label) {
          switchEntry = this.switchContinues[i];
          break;
        }
      }
    const target =
      kind === 'return'
        ? this.builder.exitIndex
        : kind === 'break'
          ? this.context.breakTarget(label)
          : (switchEntry?.target ?? this.context.continueTarget(label));
    if (target === undefined) throw new UnsupportedZigCfg();
    // A break delivers its value to the loop or labeled block it leaves; a
    // labeled-switch continue delivers it to that switch's dispatch.
    const sink = kind === 'break' ? this.resultSinks.get(target) : switchEntry?.sink;
    const { result: prefix, carriers } = this.evaluate(
      value && this.hasControl(value) ? [value] : [],
    );
    const jump = this.block(node, this.harvest.facts(node, carriers, sink));
    if (prefix) this.builder.connect(prefix.exits, jump);
    if (
      kind === 'return' &&
      value &&
      (value.type === 'error_type' || this.errorReturn || this.cleanup.some((c) => c.errorOnly))
    ) {
      // Aliases hide an error union's syntax. An explicit error still propagates;
      // an unknown value with active errdefer retains both possible completions.
      const knownError = value.type === 'error_type';
      const knownSuccess = ['integer', 'float', 'boolean', 'string', 'try_expression'].includes(
        value.type,
      );
      if (!knownError) this.complete(jump, target, kind);
      if (!knownSuccess) this.complete(jump, target, 'throw', true);
    } else this.complete(jump, target, kind);
    return { entry: prefix?.entry ?? jump, exits: [] };
  }
}

export function createZigCfgVisitor(): CfgVisitor<SyntaxNode> {
  return {
    isFunction: (node) => node.type === 'function_declaration',
    buildFunctionCfg(fn, filePath): FunctionCfg | undefined {
      if (fn.type !== 'function_declaration' || fn.hasError) return undefined;
      const body = fn.childForFieldName('body');
      if (!body) return undefined;
      const builder = new CfgBuilder(
        filePath,
        fn.startPosition.row + 1,
        fn.endPosition.row + 1,
        fn.startPosition.column,
      );
      const harvest = new ZigHarvester(fn);
      builder.attachFacts(builder.entryIndex, harvest.params());
      const walk = new ZigCfgWalk(
        builder,
        harvest,
        fn.childForFieldName('type')?.type === 'error_union_type',
      );
      // The generic collector isolates and counts unsupported bodies. Returning
      // undefined here would conceal their missing CFGs as bodyless declarations.
      const result = walk.visit(body);
      builder.edge(builder.entryIndex, result?.entry ?? builder.exitIndex, 'seq');
      if (result) builder.connect(result.exits, builder.exitIndex);
      return builder.finish(harvest.bindingTable());
    },
  };
}
