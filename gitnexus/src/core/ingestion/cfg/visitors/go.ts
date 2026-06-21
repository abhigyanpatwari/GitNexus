/**
 * Go CfgVisitor (#2195 U5, plan KTD2) — the highest-divergence C-family target.
 *
 * Walks a Go function / method / closure's tree-sitter AST and drives the
 * language-agnostic {@link CfgBuilder} to produce a serializable
 * {@link FunctionCfg}, plus a def/use harvest ({@link GoHarvester}) for the
 * reaching-defs / CDG solvers. Structured like the Java / C# visitors — a
 * `visit_<node_type>` dispatch over the statement taxonomy, driving a
 * per-function {@link ControlFlowContext} for labeled break/continue and the
 * `defer` completion chain (Go's analogue of finally route-through).
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-go via the introspection probe before use (mandatory pre-step,
 * KTD5). Go shapes pre-empted (verified by a real parse):
 *  - functions: `function_declaration`, `method_declaration` (field `receiver`),
 *    `func_literal` — all carry `parameters` + a `body` `block`.
 *  - `if_statement` fields `initializer`? / `condition` / `consequence` /
 *    `alternative`?; `else if` ⇒ `alternative` is a nested `if_statement`, plain
 *    `else` ⇒ `alternative` is a `block` (NO `else_clause` wrapper).
 *  - `for_statement` — Go's SINGLE loop keyword. `body` is a `block`; the first
 *    child is a `for_clause` (C-style, fields `initializer`?/`condition`?/`update`?)
 *    OR a `range_clause` (for-range, fields `left`?/`right`) OR a bare condition
 *    expression (while-style) OR ABSENT (`for {}` infinite). All four handled.
 *  - `expression_switch_statement` (fields `initializer`?/`value`?; children
 *    `expression_case` [field `value`=`expression_list`] / `default_case`) and
 *    `type_switch_statement` (fields `alias`?/`value`; children `type_case`
 *    [field `type`] / `default_case`) — cases do NOT fall through by default.
 *  - `fallthrough_statement` — EXPLICIT fallthrough to the next case (the
 *    opposite of C; modeled with a `fallthrough` edge).
 *  - `select_statement` (children `communication_case` [field `communication`=
 *    `receive_statement`/`send_statement`] / `default_case`).
 *  - `return_statement` (multiple-return via an `expression_list`),
 *    `break_statement` / `continue_statement` (BOTH may carry a `label_name`),
 *    `goto_statement` (`label_name` child), `labeled_statement` (field `label`=
 *    `label_name`).
 *  - `defer_statement` / `go_statement` — each wraps a `call_expression`.
 *
 * Edge-kind contract (matches the TS / Java / C# visitors — RD/CDG consume these):
 *  - if/else → `cond-true` / `cond-false`
 *  - for-loops (all four shapes) → `cond-true` / `loop-back` / `cond-false`
 *  - switch / select dispatch → `switch-case`; an explicit `fallthrough` → a
 *    `fallthrough` edge to the next case (Go cases otherwise do NOT fall through)
 *  - a `return` / normal completion threads through the active `defer` chain as
 *    `return` (first leg) + `finally-return` (each defer's completion leg)
 *  - return / break / continue → the matching terminator kind; a labeled
 *    `break outer;` / `continue outer;` targets the labeled frame, not the
 *    nearest one
 *  - straight-line → `seq`
 *
 * Go-specific modeling decisions (documented approximations — see the plan U5):
 *  - `defer f()`: deferred calls run at FUNCTION RETURN in LIFO order. Modeled as
 *    stacked completion legs (the {@link ControlFlowContext} finalizer machinery,
 *    Go's analogue of a `finally` route-through): each `defer` pushes a finalizer
 *    frame that stays active for the rest of the function, so every `return` AND
 *    the normal fall-off thread through ALL active defers innermost-first (LIFO).
 *    APPROXIMATION: a `defer` is registered at the point it executes, so a defer
 *    inside a not-yet-run branch is conservatively treated as active for the
 *    whole remaining function tail (Go would only run it if that branch ran). The
 *    panic/recover path is not modeled (documented gap).
 *  - `go f()`: spawns a goroutine — a SEPARATE flow. Decision (the simpler correct
 *    option): the `go` call is modeled as a normal straight-line statement in the
 *    CURRENT CFG and the spawned body is NOT followed inline. When the argument is
 *    a `go func(){…}()` closure, that `func_literal` is still collected as its OWN
 *    function by `isFunction` (the worker enumerates every function node), so its
 *    body gets a standalone CFG — nothing is dropped. A bare `go namedFn()` call's
 *    callee body lives in its own function CFG already. No edge is dropped, so no
 *    warning is logged for the common shapes.
 *  - `select {}` with no `default` BLOCKS forever; `for {}` (and `for cond {}`,
 *    and a `for {…}` with no `break`) may never terminate. Exactly as the sibling
 *    visitors emit a structural `header → loopExit` `cond-false` edge for
 *    `while(true)`, this visitor emits a structural exit-escape edge for EVERY
 *    for-loop shape AND for a `select` with no default, so EXIT stays
 *    reverse-reachable from every block — the post-dominator / CDG pass silently
 *    emits ZERO control-dependence for the function otherwise (CFG / REACHING_DEF
 *    survive; CDG goes to zero). This is the single highest-risk correctness
 *    property of the visitor.
 *
 * Classic hazards, handled explicitly (mirrors the Java / C# visitors):
 *  - loops allocate a dedicated loop-exit block so `break` has a target before
 *    the loop's successor is known; `continue` targets the header / update.
 *  - labeled `break outer;` / `continue outer;`: the label resolves against the
 *    frame of the construct it names (a labeled loop / switch / select), NOT the
 *    nearest enclosing frame. An UNLABELED break never targets a labeled-block
 *    frame (control-flow-context.ts enforces this).
 *  - `goto label;`: labels resolve within the function (forward AND backward);
 *    an unresolved `goto` (label in a sibling scope Go would reject, or malformed)
 *    routes to EXIT and logs, preserving single-exit.
 *
 * Known limitations:
 *  - `go`/goroutine inter-flow scheduling and channel happens-before are not
 *    modeled (each goroutine body is an independent CFG).
 *  - panic / recover: a `panic()` is a normal call here (no abnormal edge), and
 *    `recover()` inside a deferred closure is opaque; the panic-unwind path
 *    through defers is not modeled — documented gap, not faked.
 *  - Def/use harvest scope: see `go-harvest.ts` — selector / index / pointer
 *    writes are not scalar defs; `func_literal` bodies are opaque in both
 *    directions.
 *
 * Returns `undefined` (never throws) for an AST shape it cannot model, so a
 * malformed function never drops the whole file's CFG group (R4).
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import {
  ControlFlowContext,
  drainFinalizerPending,
  wireJumpThroughFinalizers,
} from '../control-flow-context.js';
import type { FinalizerFrame } from '../control-flow-context.js';
import type { TraversalResult } from '../traversal-result.js';
import type { CfgVisitor, FunctionCfg } from '../types.js';
import { GoHarvester } from './go-harvest.js';

/** Go node types that own a CFG-bearing function body. */
const GO_FUNCTION_TYPES = new Set(['function_declaration', 'method_declaration', 'func_literal']);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'type_switch_statement',
  'select_statement',
  'return_statement',
  'break_statement',
  'continue_statement',
  'goto_statement',
  'labeled_statement',
  'fallthrough_statement',
  'defer_statement',
  'block',
]);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/**
 * Per-function Go walk state. One instance per function so the
 * {@link ControlFlowContext}, the `defer` finalizer chain, and the label tables
 * are scoped to that function and never leak across functions.
 */
class GoCfgWalk {
  private readonly cfc = new ControlFlowContext();
  /** label name → its `labeled_statement` body's entry block (resolved on demand). */
  private readonly labelBlocks = new Map<string, number>();
  /** Pending gotos to a label not yet seen: label → list of source blocks. */
  private readonly pendingGotos = new Map<string, number[]>();
  /** Label(s) pending attachment to the NEXT pushed loop/switch/select frame. */
  private pendingLabels: string[] = [];
  /**
   * Active `defer` finalizer frames in source (push) order. Innermost-LIFO is the
   * REVERSE of this list — `finalizersForReturn()` already yields innermost-first,
   * matching Go's LIFO defer execution. Frames stay active for the whole function
   * tail and are drained once at the top-level walk's end.
   */
  private readonly deferFrames: FinalizerFrame[] = [];

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: GoHarvester,
  ) {}

  /** Statements of a block node, ignoring comments. */
  private statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter((c) => c.type !== 'comment');
  }

  /** The `body` block of a node. */
  private bodyBlockOf(node: SyntaxNode): SyntaxNode | undefined {
    return node.childForFieldName('body') ?? node.namedChildren.find((c) => c.type === 'block');
  }

  /** Visit a body that may be a `block` or a single statement. */
  private visitBody(node: SyntaxNode | undefined | null): SeqResult {
    return this.builder.withNesting(() => {
      if (!node) return null;
      if (node.type === 'block') return this.visitSeq(this.statementsOf(node));
      return this.visitStmt(node);
    });
  }

  /** Wire a sequence of statements, coalescing straight-line runs into blocks. */
  visitSeq(stmts: SyntaxNode[]): SeqResult {
    return this.builder.withNesting(() => {
      let entry: number | undefined;
      let dangling: number[] = [];
      let openSimple: number | undefined;

      for (const stmt of stmts) {
        if (CONTROL_FLOW_TYPES.has(stmt.type)) {
          openSimple = undefined; // close any open straight-line block
          const res = this.visitStmt(stmt);
          if (res === null) continue; // transparent (empty nested block)
          if (entry === undefined) entry = res.entry;
          else this.builder.connect(dangling, res.entry, 'seq');
          dangling = [...res.exits];
        } else {
          if (openSimple === undefined) {
            const idx = this.builder.newBlock(
              startLineOf(stmt),
              endLineOf(stmt),
              stmt.text,
              'normal',
              this.harvest.facts(stmt),
            );
            if (entry === undefined) entry = idx;
            else this.builder.connect(dangling, idx, 'seq');
            openSimple = idx;
            dangling = [idx];
          } else {
            this.builder.extendBlock(
              openSimple,
              endLineOf(stmt),
              stmt.text,
              this.harvest.facts(stmt),
            );
          }
        }
      }

      if (entry === undefined) return null;
      return { entry, exits: dangling };
    });
  }

  /** Dispatch one statement to its handler. Non-null except for empty blocks. */
  visitStmt(stmt: SyntaxNode): SeqResult {
    switch (stmt.type) {
      case 'if_statement':
        return this.visitIf(stmt);
      case 'for_statement':
        return this.visitFor(stmt);
      case 'expression_switch_statement':
        return this.visitExprSwitch(stmt);
      case 'type_switch_statement':
        return this.visitTypeSwitch(stmt);
      case 'select_statement':
        return this.visitSelect(stmt);
      case 'return_statement':
        return this.visitReturn(stmt);
      case 'break_statement':
        return this.visitBreak(stmt);
      case 'continue_statement':
        return this.visitContinue(stmt);
      case 'goto_statement':
        return this.visitGoto(stmt);
      case 'labeled_statement':
        return this.visitLabeled(stmt);
      case 'fallthrough_statement':
        return this.visitFallthrough(stmt);
      case 'defer_statement':
        return this.visitDefer(stmt);
      case 'block':
        return this.visitSeq(this.statementsOf(stmt));
      default:
        return this.visitSimple(stmt);
    }
  }

  private visitSimple(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    return { entry: idx, exits: [idx] };
  }

  /**
   * `return [expr…]` — threads through EVERY active `defer` (innermost-first =
   * LIFO) before EXIT. `finalizersForReturn()` yields the active finalizer frames
   * innermost-first, which is exactly Go's defer execution order.
   */
  private visitReturn(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    wireJumpThroughFinalizers(
      this.builder,
      idx,
      this.cfc.finalizersForReturn(),
      this.builder.exitIndex,
      'return',
    );
    return { entry: idx, exits: [] };
  }

  private visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const label = this.jumpLabel(stmt);
    const res = this.cfc.resolveBreak(label);
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'break');
    return { entry: idx, exits: [] };
  }

  private visitContinue(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const label = this.jumpLabel(stmt);
    const res = this.cfc.resolveContinue(label);
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'continue');
    return { entry: idx, exits: [] };
  }

  /** The trailing `label_name` of a `break`/`continue`, if any. */
  private jumpLabel(stmt: SyntaxNode): string | undefined {
    const id = stmt.namedChildren.find((c) => c.type === 'label_name');
    return id?.text;
  }

  /** `goto label;` — route to the label block if known, else defer / EXIT. */
  private visitGoto(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const label = stmt.namedChildren.find((c) => c.type === 'label_name')?.text;
    if (label === undefined) {
      this.builder.edge(idx, this.builder.exitIndex, 'seq'); // malformed — single-exit
      return { entry: idx, exits: [] };
    }
    const target = this.labelBlocks.get(label);
    if (target !== undefined) {
      this.builder.edge(idx, target, 'seq'); // backward goto: label already built
    } else {
      const list = this.pendingGotos.get(label);
      if (list) list.push(idx);
      else this.pendingGotos.set(label, [idx]);
    }
    return { entry: idx, exits: [] };
  }

  /**
   * `label: <statement>` — the label names the construct it directly wraps. For a
   * loop / switch / select we forward the label so its pushed frame carries it
   * (`break outer;` then resolves to it); for any other labeled statement we
   * register the label block so a `goto label` reaches it.
   */
  private visitLabeled(stmt: SyntaxNode): SeqResult {
    const labelNode = stmt.childForFieldName('label');
    const label = labelNode?.text;
    const body =
      stmt.namedChildren.find((c) => c.id !== labelNode?.id && c.type !== 'comment') ?? null;

    if (label !== undefined && body && this.isBreakableStatement(body)) {
      // Forward the label to the loop/switch/select frame this statement pushes.
      this.pendingLabels = [...this.pendingLabels, label];
      const res = this.visitStmt(body);
      this.registerLabel(label, res?.entry ?? this.synthLabelBlock(stmt));
      return res ?? { entry: this.labelBlocks.get(label)!, exits: [] };
    }

    const res = this.visitBody(body);
    if (label !== undefined) {
      const entry = res?.entry ?? this.synthLabelBlock(stmt);
      this.registerLabel(label, entry);
      if (!res) return { entry, exits: [entry] };
    }
    return res;
  }

  private synthLabelBlock(stmt: SyntaxNode): number {
    return this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');
  }

  /** Register a resolved label block and wire any forward gotos that waited on it. */
  private registerLabel(label: string, entry: number): void {
    this.labelBlocks.set(label, entry);
    const pending = this.pendingGotos.get(label);
    if (pending) {
      for (const from of pending) this.builder.edge(from, entry, 'seq');
      this.pendingGotos.delete(label);
    }
  }

  private isBreakableStatement(node: SyntaxNode): boolean {
    return (
      node.type === 'for_statement' ||
      node.type === 'expression_switch_statement' ||
      node.type === 'type_switch_statement' ||
      node.type === 'select_statement'
    );
  }

  /** Take and clear the labels queued by an enclosing `labeled_statement`. */
  private takeLabels(): string[] {
    const labels = this.pendingLabels;
    this.pendingLabels = [];
    return labels;
  }

  /**
   * `fallthrough` — EXPLICIT transfer to the next case body (Go cases do not fall
   * through implicitly). Recorded as a marker block; the enclosing switch wires
   * the `fallthrough` edge from a case body whose dangling exit is this block.
   * It carries no normal exit (control leaves to the next case).
   */
  private visitFallthrough(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    this.fallthroughBlocks.add(idx);
    return { entry: idx, exits: [idx] };
  }

  /** Blocks that are an explicit `fallthrough` terminator (per-function). */
  private readonly fallthroughBlocks = new Set<number>();

  /**
   * `defer f()` — register the deferred call as a finalizer frame that stays
   * active for the rest of the function tail. Every later `return` (and the
   * normal fall-off) threads through it; LIFO across multiple defers falls out of
   * `finalizersForReturn()` yielding innermost-first. The defer's call expression
   * carries its def/use facts. The frame is NOT popped here — the top-level walk
   * drains all defer frames once at function end.
   */
  private visitDefer(stmt: SyntaxNode): TraversalResult {
    // A single facts-only block is created for the deferred call body; it is the
    // finalizer entry that completion legs route through.
    const call = stmt.namedChildren.find((c) => c.type !== 'comment') ?? stmt;
    const deferBlock = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(call),
    );
    const frame = this.cfc.pushFinalizer(deferBlock);
    this.deferFrames.push(frame);
    // The `defer` statement itself is a no-op at its source position — control
    // falls straight through to the next statement (the deferred body only runs
    // at function exit, modeled by the completion-leg threading). We therefore
    // return a SEPARATE marker block as the in-line position so the deferred
    // block stays out of the straight-line flow.
    const marker = this.builder.newBlock(startLineOf(stmt), startLineOf(stmt), '');
    return { entry: marker, exits: [marker] };
  }

  /**
   * Drain the active `defer` chain at function end. Each deferred block is a
   * single block, so its "exit" is itself; the chain runs innermost-first (LIFO,
   * matching Go). Returns the block set control reaches AFTER the whole defer
   * chain runs (to be wired to EXIT by the caller), or `normalExits` unchanged
   * when there are no defers.
   *
   * Two completion sources converge here:
   *  - `return` statements that crossed these frames registered pending legs via
   *    `wireJumpThroughFinalizers`; {@link drainFinalizerPending} wires them
   *    (return → defer[0]; defer[i] → defer[i+1]; defer[last] → EXIT).
   *  - the function's NORMAL fall-off is threaded explicitly here through the
   *    same chain (`return` first leg, `finally-return` inter-defer legs); the
   *    builder de-dups, so legs shared with the return paths collapse.
   */
  finishDefers(normalExits: readonly number[]): readonly number[] {
    if (this.deferFrames.length === 0) return normalExits;
    // Innermost-first (LIFO): the LAST-registered defer runs first.
    const lifo = [...this.deferFrames].reverse();
    // Pop the frames off the active stack and drain any pending completion legs
    // the return/break handlers registered while these frames were active.
    for (let i = 0; i < lifo.length; i++) this.cfc.pop();
    for (const frame of lifo) drainFinalizerPending(this.builder, frame, [frame.entry]);

    // Thread the normal fall-off through the chain innermost-first: the first leg
    // keeps the bare `return` kind (the "kind ⟹ source terminator" invariant), the
    // inter-defer legs are `finally-return` completion edges.
    if (normalExits.length > 0) {
      this.builder.connect(normalExits, lifo[0].entry, 'return');
      for (let i = 0; i + 1 < lifo.length; i++) {
        this.builder.edge(lifo[i].entry, lifo[i + 1].entry, 'finally-return');
      }
    }
    // After the outermost defer runs, control reaches EXIT.
    return [lifo[lifo.length - 1].entry];
  }

  /**
   * Route any forward `goto`s whose label never appeared in the function to EXIT
   * (single-exit preserved) and log them so a dropped jump is never silent (R4).
   * Called once after the body walk.
   */
  flushGotos(builder: CfgBuilder): void {
    for (const [label, froms] of this.pendingGotos) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cfg] Go: unresolved goto label "${label}" routed to EXIT (${froms.length} site(s))`,
      );
      for (const from of froms) builder.edge(from, builder.exitIndex, 'seq');
    }
    this.pendingGotos.clear();
  }

  private visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const init = stmt.childForFieldName('initializer');
    // The header block carries the (optional) initializer's facts AND the
    // condition's facts — both evaluate before the branch.
    const header = this.builder.newBlock(
      init ? startLineOf(init) : startLineOf(stmt),
      endLineOf(cond),
      init ? `${init.text}; ${cond.text}` : cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    if (init) this.builder.attachFacts(header, this.harvest.facts(init));

    const exits: number[] = [];

    const thenRes = this.visitBody(stmt.childForFieldName('consequence'));
    if (thenRes) {
      this.builder.edge(header, thenRes.entry, 'cond-true');
      exits.push(...thenRes.exits);
    } else {
      exits.push(header); // empty then — true path falls through
    }

    // No `else_clause` wrapper in Go: `alternative` is the else `block` or the
    // nested `if_statement` of an `else if` chain directly.
    const elseNode = stmt.childForFieldName('alternative');
    if (elseNode) {
      const elseRes = this.visitBody(elseNode);
      if (elseRes) {
        this.builder.edge(header, elseRes.entry, 'cond-false');
        exits.push(...elseRes.exits);
      } else {
        exits.push(header);
      }
    } else {
      exits.push(header); // no else — false path falls through to the join
    }

    return { entry: header, exits: [...new Set(exits)] };
  }

  /**
   * `for_statement` — Go's single loop keyword covers all four shapes:
   *   1. `for clause { }`  (`for_clause`: init?/cond?/update? — C-style)
   *   2. `for range x { }` (`range_clause`)
   *   3. `for cond { }`    (a bare condition expression — while-style)
   *   4. `for { }`         (no header child — infinite)
   */
  private visitFor(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const head = this.forHeadChild(stmt);
    if (head?.type === 'for_clause') return this.visitForClause(stmt, head, labels);
    if (head?.type === 'range_clause') return this.visitForRange(stmt, head, labels);
    // While-style (bare condition) or infinite (`for {}`): `head` is the
    // condition expression (or undefined).
    return this.visitForCond(stmt, head ?? undefined, labels);
  }

  /** The header child of a `for_statement` (for_clause / range_clause / cond), or undefined. */
  private forHeadChild(stmt: SyntaxNode): SyntaxNode | undefined {
    const body = stmt.childForFieldName('body');
    return stmt.namedChildren.find((c) => c.id !== body?.id && c.type !== 'comment');
  }

  private visitForClause(stmt: SyntaxNode, clause: SyntaxNode, labels: string[]): TraversalResult {
    const init = clause.childForFieldName('initializer');
    const cond = clause.childForFieldName('condition');
    const incr = clause.childForFieldName('update');

    const header = this.builder.newBlock(
      cond ? startLineOf(cond) : startLineOf(stmt),
      cond ? endLineOf(cond) : startLineOf(stmt),
      cond ? cond.text : 'for{}',
      'normal',
      cond ? this.harvest.facts(cond) : undefined,
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    let incrBlock = header;
    if (incr) {
      incrBlock = this.builder.newBlock(
        startLineOf(incr),
        endLineOf(incr),
        incr.text,
        'normal',
        this.harvest.facts(incr),
      );
      this.builder.edge(incrBlock, header, 'loop-back');
    }

    this.cfc.pushLoop(incrBlock, loopExit, labels);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, incrBlock, incr ? 'seq' : 'loop-back');
    } else {
      this.builder.edge(header, incrBlock, 'cond-true');
      if (!incr) this.builder.edge(header, header, 'loop-back');
    }
    // Structural exit edge — `for ;; {}` (no condition) still keeps EXIT
    // reverse-reachable so CDG is not silently skipped for the function.
    this.builder.edge(header, loopExit, 'cond-false');

    let entry = header;
    if (init) {
      const initBlock = this.builder.newBlock(
        startLineOf(init),
        endLineOf(init),
        init.text,
        'normal',
        this.harvest.facts(init),
      );
      this.builder.edge(initBlock, header, 'seq');
      entry = initBlock;
    }
    return { entry, exits: [loopExit] };
  }

  private visitForRange(stmt: SyntaxNode, clause: SyntaxNode, labels: string[]): TraversalResult {
    // Header carries the range head facts (loop vars are defs, the iterated
    // expression is a use).
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(clause),
      clause.text,
      'normal',
      this.harvest.rangeHeadFacts(clause),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back');
    }
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private visitForCond(
    stmt: SyntaxNode,
    cond: SyntaxNode | undefined,
    labels: string[],
  ): TraversalResult {
    const header = this.builder.newBlock(
      cond ? startLineOf(cond) : startLineOf(stmt),
      cond ? endLineOf(cond) : startLineOf(stmt),
      cond ? cond.text : 'for{}',
      'normal',
      cond ? this.harvest.facts(cond) : undefined,
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty `for {}` body re-tests
    }
    // Always emit the structural exit edge — even `for {}` (infinite, no
    // condition) and `for cond {}` keep EXIT reverse-reachable for the CDG pass.
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private visitExprSwitch(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const value = stmt.childForFieldName('value');
    const init = stmt.childForFieldName('initializer');
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      value ? endLineOf(value) : startLineOf(stmt),
      value ? value.text : 'switch{}',
      'normal',
      value ? this.harvest.facts(value) : undefined,
    );
    if (init) this.builder.attachFacts(dispatch, this.harvest.facts(init));
    const switchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushSwitch(switchExit, labels);
    const cases = stmt.namedChildren.filter(
      (c) => c.type === 'expression_case' || c.type === 'default_case',
    );

    // Each `expression_case`'s test value(s) evaluate before the body — harvest
    // their uses CONDITIONALLY onto the dispatch block (a later case only tests
    // when earlier cases didn't match).
    for (const c of cases) {
      if (c.type !== 'expression_case') continue;
      const test = c.childForFieldName('value');
      if (test) this.builder.attachFacts(dispatch, this.harvest.factsConditional(test));
    }

    const result = this.buildCases(dispatch, switchExit, cases, (c) => this.exprCaseBody(c));
    this.cfc.pop();
    return result;
  }

  private visitTypeSwitch(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      this.typeSwitchHeaderText(stmt),
      'normal',
      this.harvest.typeSwitchHeadFacts(stmt),
    );
    const switchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushSwitch(switchExit, labels);
    const cases = stmt.namedChildren.filter(
      (c) => c.type === 'type_case' || c.type === 'default_case',
    );
    const result = this.buildCases(dispatch, switchExit, cases, (c) => this.typeCaseBody(c));
    this.cfc.pop();
    return result;
  }

  private visitSelect(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const dispatch = this.builder.newBlock(startLineOf(stmt), startLineOf(stmt), 'select');
    const selectExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushSwitch(selectExit, labels);
    const cases = stmt.namedChildren.filter(
      (c) => c.type === 'communication_case' || c.type === 'default_case',
    );

    // A comm case's communication clause (`v := <-ch` / `ch <- x`) evaluates as
    // part of dispatch — harvest its facts onto the dispatch block.
    for (const c of cases) {
      if (c.type !== 'communication_case') continue;
      const comm = c.childForFieldName('communication');
      if (comm) this.builder.attachFacts(dispatch, this.harvest.facts(comm));
    }

    const hasDefault = cases.some((c) => c.type === 'default_case');
    const result = this.buildCases(dispatch, selectExit, cases, (c) => this.commCaseBody(c));

    // A `select` with NO default BLOCKS until a case is ready — and a `select {}`
    // with no cases at all blocks forever. Either way EXIT must stay
    // reverse-reachable: emit a structural escape edge dispatch → selectExit so
    // the CDG pass is not silently skipped for the function.
    if (!hasDefault) this.builder.edge(dispatch, selectExit, 'switch-case');

    this.cfc.pop();
    return result;
  }

  /**
   * Shared dispatch builder for expression-switch / type-switch / select. Cases
   * do NOT fall through by default (the opposite of C); an EXPLICIT
   * `fallthrough` block in a case body spills into the NEXT case instead of the
   * switch exit. `default_case` is the no-match target; without one, the dispatch
   * also reaches the switch exit directly (no-match path).
   */
  private buildCases(
    dispatch: number,
    switchExit: number,
    cases: SyntaxNode[],
    bodyOf: (c: SyntaxNode) => SyntaxNode[],
  ): TraversalResult {
    const caseResults = cases.map((c) => this.visitSeq(bodyOf(c)));
    const hasDefault = cases.some((c) => c.type === 'default_case');

    const entryOf: number[] = new Array(cases.length);
    let after = switchExit;
    for (let i = cases.length - 1; i >= 0; i--) {
      entryOf[i] = caseResults[i]?.entry ?? after;
      after = entryOf[i];
    }

    for (let i = 0; i < cases.length; i++) {
      this.builder.edge(dispatch, entryOf[i], 'switch-case');
    }
    if (!hasDefault) this.builder.edge(dispatch, switchExit, 'switch-case'); // no-match path

    // Case bodies rejoin AFTER the switch (no implicit fallthrough), UNLESS the
    // body ends in an explicit `fallthrough`, which spills into the next case.
    for (let i = 0; i < cases.length; i++) {
      const res = caseResults[i];
      if (!res) continue;
      const fallTarget = i + 1 < cases.length ? entryOf[i + 1] : switchExit;
      for (const ex of res.exits) {
        if (this.fallthroughBlocks.has(ex)) {
          this.builder.edge(ex, fallTarget, 'fallthrough');
        } else {
          this.builder.edge(ex, switchExit, 'seq');
        }
      }
    }

    return { entry: dispatch, exits: [switchExit] };
  }

  /** `expression_case` body statements (everything but the `value` test). */
  private exprCaseBody(caseNode: SyntaxNode): SyntaxNode[] {
    const value = caseNode.childForFieldName('value');
    return caseNode.namedChildren.filter((c) => c.id !== value?.id && c.type !== 'comment');
  }

  /** `type_case` body statements (everything but the `type` field children). */
  private typeCaseBody(caseNode: SyntaxNode): SyntaxNode[] {
    const typeIds = new Set<number>();
    // All `type` field children (a type_case may list several types).
    for (let i = 0; i < caseNode.childCount; i++) {
      if (caseNode.fieldNameForChild(i) === 'type') {
        const c = caseNode.child(i);
        if (c) typeIds.add(c.id);
      }
    }
    return caseNode.namedChildren.filter((c) => !typeIds.has(c.id) && c.type !== 'comment');
  }

  /** `communication_case` body statements (everything but the `communication` clause). */
  private commCaseBody(caseNode: SyntaxNode): SyntaxNode[] {
    const comm = caseNode.childForFieldName('communication');
    return caseNode.namedChildren.filter((c) => c.id !== comm?.id && c.type !== 'comment');
  }

  private typeSwitchHeaderText(stmt: SyntaxNode): string {
    const alias = stmt.childForFieldName('alias')?.text;
    const value = stmt.childForFieldName('value')?.text ?? '';
    return alias ? `switch ${alias} := ${value}.(type)` : `switch ${value}.(type)`;
  }
}

/** Build the CFG for one Go function node, or `undefined` if not modelable. */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  try {
    if (!GO_FUNCTION_TYPES.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    const body = fnNode.childForFieldName('body');
    if (!body || body.type !== 'block') return undefined; // forward decl / interface method

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new GoHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    const walk = new GoCfgWalk(builder, harvest);
    const res = walk.visitSeq(body.namedChildren.filter((c) => c.type !== 'comment'));

    builder.edge(builder.entryIndex, res ? res.entry : builder.exitIndex, 'seq');
    // Normal fall-off threads through the active `defer` chain (LIFO) → EXIT.
    const normalExits = res ? res.exits : [builder.entryIndex];
    const afterDefers = walk.finishDefers(normalExits);
    builder.connect(afterDefers, builder.exitIndex, 'seq');
    walk.flushGotos(builder);
    return builder.finish(harvest.bindingTable());
  } catch (err) {
    // Never throw out of buildFunctionCfg — a malformed AST shape must skip only
    // this one function's CFG, never drop the whole file's language group (R4).
    // eslint-disable-next-line no-console
    console.warn(`[cfg] Go buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** Whether a node is a Go function this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return GO_FUNCTION_TYPES.has(node.type);
}

/** The Go CFG visitor. */
export function createGoCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { GO_FUNCTION_TYPES };
