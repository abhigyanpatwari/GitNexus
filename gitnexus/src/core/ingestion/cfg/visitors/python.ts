/**
 * Python CfgVisitor — the most STRUCTURALLY DIVERGENT CFG target (PDG layer
 * beyond the C-family). Python has no braces (suites are indented `block` nodes),
 * `elif` clauses, `for`/`while ... else` (the else runs on NORMAL completion, not
 * on `break`), `with` (deterministic `__exit__` on both normal AND exception
 * exit — a try/finally analogue), `try` / `except` / `except-group` (except-star)
 * / `else` / `finally`, and `match`/`case` (no fallthrough). A good stress test
 * that the shared CFG core
 * carries no hidden brace-family assumptions.
 *
 * Walks a Python `function_definition` / `lambda`'s tree-sitter AST and drives
 * the language-agnostic {@link CfgBuilder} to produce a serializable
 * {@link FunctionCfg}, plus a def/use harvest ({@link PythonHarvester}) for the
 * reaching-defs / CDG solvers. Structured like the C-family visitors — a
 * `visit_<node_type>` dispatch over the statement taxonomy, driving a
 * per-function {@link ControlFlowContext} for break/continue and the `with` /
 * `finally` completion chain (finalizer route-through). NO call-site `sites[]`
 * are harvested (taint substrate is a later step — see python-harvest.ts).
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-python (0.23.x) via the introspection probe before use (mandatory
 * pre-step). Python shapes pre-empted (verified by a real parse):
 *  - functions: `function_definition` (fields `name`/`parameters`/`body`; async
 *    is the SAME node with an `async` token child), `lambda` (fields
 *    `parameters`/`body`; the body is an EXPRESSION, not a `block`).
 *  - `if_statement` fields `condition`/`consequence` plus ZERO-OR-MORE
 *    `alternative` fields, each an `elif_clause` (fields `condition`/`consequence`)
 *    or an `else_clause` (field `body`) — Python has no nested-`if` else chain.
 *  - `for_statement` fields `left`/`right`/`body` + optional `alternative`
 *    (`else_clause`); `while_statement` fields `condition`/`body` + optional
 *    `alternative` (`else_clause`). The loop `else` runs on the cond-false /
 *    normal-completion path, NOT on `break`.
 *  - `with_statement` field `body`; a `with_clause` of `with_item`s (field
 *    `value` = `as_pattern` or a bare expression). `__exit__` runs on normal AND
 *    exception exit — modeled as a finalizer (try/finally analogue).
 *  - `try_statement` field `body`; children `except_clause` /
 *    `except_group_clause` (each holds the exception expr/`as_pattern` + a
 *    `block`), `else_clause` (field `body`, runs if NO exception), and
 *    `finally_clause` (holds a `block`).
 *  - `match_statement` fields `subject`/`body`; the `body` `block` holds
 *    `case_clause`s (field `alternative`), each with `case_pattern` child(ren),
 *    an optional `guard` (`if_clause`), and a `consequence` `block`. No
 *    fallthrough between cases.
 *  - `return_statement` / `raise_statement` / `break_statement` /
 *    `continue_statement` / `pass_statement`.
 *
 * Edge-kind contract (matches the existing visitors — RD/CDG consume these):
 *  - if/elif/else → `cond-true` / `cond-false`
 *  - for/while → `cond-true` / `loop-back` / `cond-false`; the loop `else` runs
 *    on the `cond-false` / normal-completion path (NOT on `break`)
 *  - match dispatch → `switch-case` (no fallthrough — like Go's switch)
 *  - try/except → `throw` (every protected block → each except handler)
 *  - a `break`/`continue`/`return` crossing a `with` `__exit__` or a `finally`
 *    threads through as `break`/`continue`/`return` (first leg) +
 *    `finally-break`/`finally-continue`/`finally-return` (each completion leg)
 *  - return/raise/break/continue → the matching terminator kind
 *  - straight-line → `seq`
 *
 * Python-specific modeling decisions (documented approximations):
 *  - `with EXPR as t:` runs the body then `__exit__` deterministically on BOTH
 *    the normal exit and an exception (it can suppress the exception, but the
 *    common case re-raises). Modeled exactly like `try/finally`: a finalizer
 *    frame for the body's exit-dispose, with the protected body edging the
 *    dispose block on `throw`. APPROXIMATION: exception SUPPRESSION by a context
 *    manager is not modeled (the dispose re-propagates), the sound direction.
 *  - the loop `else` clause runs once on normal completion (the loop ran to
 *    exhaustion without `break`). It sits on the `cond-false` edge BEFORE the
 *    join; a `break` targets the loop exit AFTER the else, so `break` skips it.
 *  - `match`/`case` cases do NOT fall through (like Go). The dispatch fans a
 *    `switch-case` edge to each case body; a guarded / non-wildcard tail with no
 *    `case _` also reaches the join directly (no-match path), keeping EXIT
 *    reverse-reachable.
 *  - `while True:` (and any loop with no statically-false exit) STILL emits the
 *    structural `header → loopExit` `cond-false` edge — exactly like the
 *    C-family visitors — so EXIT stays reverse-reachable and the post-dominator /
 *    CDG pass is not silently skipped for the function. Highest-risk property.
 *  - `lambda` has an EXPRESSION body (no `block`): one block whose value is the
 *    returned expression.
 *  - comprehensions are harvested for their target bindings but kept INLINE (no
 *    separate CFG blocks) — the plan's explicit choice.
 *
 * Known limitations:
 *  - async (`async def`, `await`, `async for`, `async with`) is the same node
 *    shape as the sync form plus an `async` token; the suspension points are
 *    modeled as normal straight-line control flow (no scheduler edges).
 *  - generators (`yield` / `yield from`): a `yield` is a normal expression here
 *    (no suspend/resume edge); the generator's resumption flow is not modeled.
 *  - comprehension target scoping: comprehension targets are declared in the
 *    single function table (Python 3 gives them their own scope; the leaked-name
 *    distinction is not modeled) — see python-harvest.ts.
 *  - context-manager exception SUPPRESSION and `recover`-style flow are not
 *    modeled (the `with` dispose always re-propagates).
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
import type { TraversalResult } from '../traversal-result.js';
import type { CfgVisitor, FunctionCfg } from '../types.js';
import { PythonHarvester } from './python-harvest.js';

/** Python node types that own a CFG-bearing function body. */
const PY_FUNCTION_TYPES = new Set(['function_definition', 'lambda']);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'with_statement',
  'try_statement',
  'match_statement',
  'return_statement',
  'raise_statement',
  'break_statement',
  'continue_statement',
  'block',
]);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/**
 * Per-function Python walk state. One instance per function so the
 * {@link ControlFlowContext}, the exception-handler stack, and the `with` /
 * `finally` finalizer chain are scoped to that function and never leak across
 * functions.
 */
class PythonCfgWalk {
  private readonly cfc = new ControlFlowContext();
  /** Stack of exception-handler entry blocks (except/finally/with-dispose) a `raise` jumps to. */
  private readonly handlers: number[] = [];

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: PythonHarvester,
  ) {}

  /** Statements of a block node, ignoring comments. */
  private statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter((c) => c.type !== 'comment');
  }

  /** The `body` block of a node (field, or the first `block` child). */
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
      case 'while_statement':
        return this.visitWhile(stmt);
      case 'with_statement':
        return this.visitWith(stmt);
      case 'try_statement':
        return this.visitTry(stmt);
      case 'match_statement':
        return this.visitMatch(stmt);
      case 'return_statement':
        return this.visitReturn(stmt);
      case 'raise_statement':
        return this.visitRaise(stmt);
      case 'break_statement':
        return this.visitBreak(stmt);
      case 'continue_statement':
        return this.visitContinue(stmt);
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

  /** `return [expr]` — threads through EVERY active `with`/`finally` before EXIT. */
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

  /** `raise [expr]` — jumps to the nearest handler (except / with-dispose / EXIT). */
  private visitRaise(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    this.builder.edge(idx, this.currentHandler(), 'throw');
    return { entry: idx, exits: [] };
  }

  private visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const res = this.cfc.resolveBreak();
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'break');
    return { entry: idx, exits: [] };
  }

  private visitContinue(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const res = this.cfc.resolveContinue();
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'continue');
    return { entry: idx, exits: [] };
  }

  /**
   * `if cond: … elif cond: … else: …`. Python has NO nested-if else chain: an
   * `if_statement` carries the condition + consequence plus zero-or-more
   * `alternative` fields, each an `elif_clause` (its own condition + consequence)
   * or a single trailing `else_clause`. The elif chain is threaded on the
   * `cond-false` edge.
   */
  private visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );

    const exits: number[] = [];
    const thenRes = this.visitBody(stmt.childForFieldName('consequence'));
    if (thenRes) {
      this.builder.edge(header, thenRes.entry, 'cond-true');
      exits.push(...thenRes.exits);
    } else {
      exits.push(header); // empty then — true path falls through
    }

    // The alternatives, in source order: elif_clause* then optional else_clause.
    const alternatives = this.alternativesOf(stmt);
    let falseFrom = header; // block whose cond-false edge feeds the next alternative
    for (const alt of alternatives) {
      if (alt.type === 'elif_clause') {
        const elifCond = alt.childForFieldName('condition') ?? alt;
        const elifHeader = this.builder.newBlock(
          startLineOf(alt),
          endLineOf(elifCond),
          elifCond.text,
          'normal',
          this.harvest.facts(elifCond),
        );
        this.builder.edge(falseFrom, elifHeader, 'cond-false');
        const elifRes = this.visitBody(alt.childForFieldName('consequence'));
        if (elifRes) {
          this.builder.edge(elifHeader, elifRes.entry, 'cond-true');
          exits.push(...elifRes.exits);
        } else {
          exits.push(elifHeader);
        }
        falseFrom = elifHeader;
      } else if (alt.type === 'else_clause') {
        const elseRes = this.visitBody(alt.childForFieldName('body'));
        if (elseRes) {
          this.builder.edge(falseFrom, elseRes.entry, 'cond-false');
          exits.push(...elseRes.exits);
        } else {
          exits.push(falseFrom);
        }
        falseFrom = -1; // an else consumes the false path entirely
      }
    }
    // No trailing else: the last header's cond-false falls through to the join.
    if (falseFrom >= 0) exits.push(falseFrom);

    return { entry: header, exits: [...new Set(exits)] };
  }

  /** The `alternative`-field children of an `if_statement`, in source order. */
  private alternativesOf(stmt: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let i = 0; i < stmt.childCount; i++) {
      if (stmt.fieldNameForChild(i) === 'alternative') {
        const c = stmt.child(i);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /**
   * `for TARGET in ITER: … [else: …]`. Header = the iteration test (a use of the
   * iterable + a def of the target). The loop `else` runs on NORMAL completion
   * (the cond-false path) — a `break` targets the loop exit AFTER the else, so it
   * skips the else.
   */
  private visitFor(stmt: SyntaxNode): TraversalResult {
    const left = stmt.childForFieldName('left');
    const right = stmt.childForFieldName('right');
    const headEnd = right ? endLineOf(right) : startLineOf(stmt);
    const header = this.builder.newBlock(
      startLineOf(stmt),
      headEnd,
      this.loopHeaderText(stmt, left, right),
      'normal',
      this.harvest.loopHeadFacts(stmt),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, []);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-tests
    }

    this.wireLoopElse(stmt, header, loopExit);
    return { entry: header, exits: [loopExit] };
  }

  /** `while cond: … [else: …]`. Same `else`-on-normal-completion semantics as `for`. */
  private visitWhile(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, []);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty `while c: pass` re-tests
    }

    this.wireLoopElse(stmt, header, loopExit);
    return { entry: header, exits: [loopExit] };
  }

  /**
   * Wire the optional loop `else` clause. The else runs once on normal completion
   * (the header's `cond-false` edge). With an else, the cond-false edge goes
   * `header → elseEntry` and the else's exits reach `loopExit`; without one, the
   * structural `header → loopExit` `cond-false` edge keeps EXIT reverse-reachable
   * (critical for `while True:` — and matches the C-family visitors). A `break`
   * always targets `loopExit` directly, so it never runs the else.
   */
  private wireLoopElse(stmt: SyntaxNode, header: number, loopExit: number): void {
    const elseClause = this.loopElseOf(stmt);
    if (elseClause) {
      const elseRes = this.visitBody(elseClause.childForFieldName('body'));
      if (elseRes) {
        this.builder.edge(header, elseRes.entry, 'cond-false');
        this.builder.connect(elseRes.exits, loopExit, 'seq');
        return;
      }
    }
    // No (or empty) else — normal completion falls straight to the loop exit.
    this.builder.edge(header, loopExit, 'cond-false');
  }

  /** The `else_clause` of a `for`/`while` (its `alternative` field), if any. */
  private loopElseOf(stmt: SyntaxNode): SyntaxNode | undefined {
    const alt = stmt.childForFieldName('alternative');
    return alt?.type === 'else_clause' ? alt : undefined;
  }

  private loopHeaderText(
    stmt: SyntaxNode,
    left: SyntaxNode | null,
    right: SyntaxNode | null,
  ): string {
    const l = left?.text ?? '';
    const r = right?.text ?? '';
    return l || r ? `for ${l} in ${r}` : stmt.text.split('\n')[0];
  }

  /**
   * `with EXPR [as t], …: BODY`. The context managers' `__exit__` runs
   * deterministically on BOTH the normal exit and an exception — modeled exactly
   * like `try/finally`: a finalizer frame holding the dispose block, plus a
   * `throw` edge from every protected-body block to the dispose. A
   * `return`/`break`/`continue` inside the body threads through the dispose. The
   * dispose re-propagates on the exception path (suppression is not modeled).
   */
  private visitWith(stmt: SyntaxNode): SeqResult {
    // The dispose block carries the `with`-header facts (the `as` aliases are
    // defs, the manager expressions uses) — it runs on every exit, so attaching
    // the binding facts here is the single execution point of the bindings.
    const items = this.withItems(stmt);
    const dispose = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      this.withHeaderText(stmt),
    );
    for (const item of items) this.builder.attachFacts(dispose, this.harvest.withItemFacts(item));

    const finFrame = this.cfc.pushFinalizer(dispose);
    // The body raises into the dispose (which re-propagates to the outer handler).
    this.handlers.push(dispose);
    const protectedStart = this.builder.blockCount;
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.handlers.pop();

    // Conservative exceptional edges: ANY block in the with-body may raise to the
    // dispose (an exception fires mid-block) — sound over-approximation.
    for (let b = protectedStart; b < this.builder.blockCount; b++) {
      this.builder.edge(b, dispose, 'throw');
    }

    this.cfc.pop();
    drainFinalizerPending(this.builder, finFrame, [dispose]);

    // Normal completion of the body flows into the dispose; the dispose's normal
    // exit is the with-statement's exit. The dispose re-propagates the exception
    // path to the OUTER handler (a CM normally re-raises).
    if (body) this.builder.connect(body.exits, dispose, 'seq');
    this.builder.edge(dispose, this.currentHandler(), 'throw');

    const entry = body?.entry ?? dispose;
    return { entry, exits: [dispose] };
  }

  /** The `with_item`s of a `with_statement` (under its `with_clause`). */
  private withItems(stmt: SyntaxNode): SyntaxNode[] {
    const clause = stmt.namedChildren.find((c) => c.type === 'with_clause');
    if (!clause) return [];
    return clause.namedChildren.filter((c) => c.type === 'with_item');
  }

  private withHeaderText(stmt: SyntaxNode): string {
    const clause = stmt.namedChildren.find((c) => c.type === 'with_clause');
    return clause ? `with ${clause.text}` : 'with';
  }

  /**
   * `try: BODY [except …: H]* [else: E] [finally: F]`. Mirrors the TS visitor's
   * try-route-through:
   *  - `finally` runs on every exit (normal, exception, and early jumps) — a
   *    finalizer frame for early-exit threading + a normal/exceptional join.
   *  - each `except` / except-group handler catches from the protected body.
   *  - `else` runs only if the body completed with no exception.
   */
  private visitTry(stmt: SyntaxNode): SeqResult {
    const bodyNode = stmt.childForFieldName('body');
    const exceptClauses: SyntaxNode[] = [];
    let elseClause: SyntaxNode | undefined;
    let finallyClause: SyntaxNode | undefined;
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const c = stmt.namedChild(i);
      if (!c) continue;
      if (c.type === 'except_clause' || c.type === 'except_group_clause') exceptClauses.push(c);
      else if (c.type === 'else_clause') elseClause = c;
      else if (c.type === 'finally_clause') finallyClause = c;
    }

    // Build finally first — known as both a normal join and a handler target. It
    // runs OUTSIDE this try's finalizer frame (a return inside finally threads
    // only OUTER finallys).
    const finallyBlock = finallyClause
      ? (this.bodyBlockOf(finallyClause) ??
        finallyClause.namedChildren.find((c) => c.type === 'block'))
      : undefined;
    const finallyRes = finallyBlock ? this.visitSeq(this.statementsOf(finallyBlock)) : null;
    const finFrame = finallyRes ? this.cfc.pushFinalizer(finallyRes.entry) : null;

    // Each except handler. A `raise` inside a handler propagates to finally (if
    // any), else the outer handler.
    const handlerEntries: number[] = [];
    const handlerExits: number[] = [];
    for (const clause of exceptClauses) {
      if (finallyRes) this.handlers.push(finallyRes.entry);
      const handlerBlock = clause.namedChildren.find((c) => c.type === 'block');
      // The `except E as e:` header binds `e` — its own facts-only block in front
      // of the handler body (the binding happens once, on handler entry).
      const headFacts = this.harvest.exceptHeadFacts(clause);
      const headBlock = this.builder.newBlock(
        startLineOf(clause),
        startLineOf(clause),
        '',
        'normal',
        headFacts,
      );
      const bodyRes = handlerBlock ? this.visitSeq(this.statementsOf(handlerBlock)) : null;
      if (bodyRes) {
        this.builder.edge(headBlock, bodyRes.entry, 'seq');
        handlerExits.push(...bodyRes.exits);
      } else {
        handlerExits.push(headBlock); // empty handler body — header is the exit
      }
      handlerEntries.push(headBlock);
      if (finallyRes) this.handlers.pop();
    }

    // Handler for the try body: the first except if present, else finally, else
    // the outer handler.
    const tryHandler = handlerEntries[0] ?? finallyRes?.entry ?? this.currentHandler();
    const protectedStart = this.builder.blockCount;
    this.handlers.push(tryHandler);
    const bodyRes = bodyNode ? this.visitSeq(this.statementsOf(bodyNode)) : null;
    this.handlers.pop();

    // Conservative exceptional edges: ANY protected-region block may raise to
    // EACH handler (an unmatched exception type tries the next handler).
    if (exceptClauses.length > 0 || finallyClause) {
      const targets =
        handlerEntries.length > 0 ? handlerEntries : finallyRes ? [finallyRes.entry] : [];
      for (let b = protectedStart; b < this.builder.blockCount; b++) {
        for (const h of targets) this.builder.edge(b, h, 'throw');
      }
    }

    // The `else` runs only on no-exception normal completion of the body.
    let normalAfterBody: number[] = bodyRes ? [...bodyRes.exits] : [];
    if (elseClause) {
      const elseRes = this.visitBody(elseClause.childForFieldName('body'));
      if (elseRes && bodyRes) {
        this.builder.connect(bodyRes.exits, elseRes.entry, 'seq');
        normalAfterBody = [...elseRes.exits];
      } else if (elseRes) {
        normalAfterBody = [...elseRes.exits];
      }
    }

    // Close the finalizer frame; wire crossing-jump completion legs.
    if (finFrame && finallyRes) {
      this.cfc.pop();
      drainFinalizerPending(this.builder, finFrame, finallyRes.exits);
    }

    const exits: number[] = [];
    if (finallyRes) {
      // Normal completion of (body→else) AND each handler flows through finally.
      this.builder.connect(normalAfterBody, finallyRes.entry, 'seq');
      this.builder.connect(handlerExits, finallyRes.entry, 'seq');
      exits.push(...finallyRes.exits);
      // A try with no except → an uncaught exception re-propagates after finally.
      if (handlerEntries.length === 0) {
        this.builder.connect(finallyRes.exits, this.currentHandler(), 'throw');
      }
    } else {
      exits.push(...normalAfterBody);
      exits.push(...handlerExits);
    }

    const entry = bodyRes?.entry ?? finallyRes?.entry ?? handlerEntries[0];
    if (entry === undefined) return null;
    return { entry, exits: [...new Set(exits)] };
  }

  /**
   * `match SUBJECT: case P [if guard]: BODY …`. Cases do NOT fall through (like
   * Go's switch). Each case body is dispatched from the subject block with a
   * `switch-case` edge; a `match` with no `case _` wildcard also reaches the join
   * directly (no-match path), keeping EXIT reverse-reachable.
   */
  private visitMatch(stmt: SyntaxNode): TraversalResult {
    const subject = stmt.childForFieldName('subject');
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      subject ? endLineOf(subject) : startLineOf(stmt),
      subject ? `match ${subject.text}` : 'match',
      'normal',
      subject ? this.harvest.facts(subject) : undefined,
    );
    const matchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    const body =
      stmt.childForFieldName('body') ?? stmt.namedChildren.find((c) => c.type === 'block');
    const cases = body ? body.namedChildren.filter((c) => c.type === 'case_clause') : [];

    // A case guard (`case P if g:`) evaluates conditionally — harvest its uses
    // onto the dispatch block (a later case only tests when earlier patterns
    // didn't match; defs there are may-defs).
    for (const c of cases) {
      const guard = c.childForFieldName('guard');
      if (guard) this.builder.attachFacts(dispatch, this.harvest.factsConditional(guard));
    }

    this.cfc.pushSwitch(matchExit, []);
    let hasWildcard = false;
    for (const c of cases) {
      const caseBody = this.visitBody(c.childForFieldName('consequence'));
      const entry = caseBody?.entry ?? matchExit;
      this.builder.edge(dispatch, entry, 'switch-case');
      if (caseBody) this.builder.connect(caseBody.exits, matchExit, 'seq');
      if (this.isWildcardCase(c)) hasWildcard = true;
    }
    this.cfc.pop();

    // No catch-all `case _` (or no cases) → a no-match path reaches the exit
    // directly. Keeps EXIT reverse-reachable even when every case body jumps.
    if (!hasWildcard) this.builder.edge(dispatch, matchExit, 'switch-case');

    return { entry: dispatch, exits: [matchExit] };
  }

  /** A `case _:` (bare wildcard with no guard) is the unconditional catch-all. */
  private isWildcardCase(caseClause: SyntaxNode): boolean {
    if (caseClause.childForFieldName('guard')) return false;
    const pattern = caseClause.namedChildren.find((c) => c.type === 'case_pattern');
    return pattern?.text.trim() === '_';
  }

  /** Nearest enclosing exception handler, or the function EXIT. */
  private currentHandler(): number {
    return this.handlers.length ? this.handlers[this.handlers.length - 1] : this.builder.exitIndex;
  }
}

/** Build the CFG for one Python function/lambda node, or `undefined` if not modelable. */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  try {
    if (!PY_FUNCTION_TYPES.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    const body = fnNode.childForFieldName('body');
    if (!body) return undefined; // no body — nothing to model

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new PythonHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    if (fnNode.type === 'lambda' || body.type !== 'block') {
      // `lambda x: expr` — the body is an EXPRESSION (no `block`): one block whose
      // value is returned. Threads through no finally (a lambda has none).
      const blk = builder.newBlock(
        startLineOf(body),
        endLineOf(body),
        body.text,
        'normal',
        harvest.facts(body),
      );
      builder.edge(builder.entryIndex, blk, 'seq');
      builder.edge(blk, builder.exitIndex, 'return');
      return builder.finish(harvest.bindingTable());
    }

    const walk = new PythonCfgWalk(builder, harvest);
    const res = walk.visitSeq(body.namedChildren.filter((c) => c.type !== 'comment'));
    if (!res) {
      builder.edge(builder.entryIndex, builder.exitIndex, 'seq'); // empty body
      return builder.finish(harvest.bindingTable());
    }
    builder.edge(builder.entryIndex, res.entry, 'seq');
    builder.connect(res.exits, builder.exitIndex, 'seq'); // normal fall-off → EXIT
    return builder.finish(harvest.bindingTable());
  } catch (err) {
    // Never throw out of buildFunctionCfg — a malformed AST shape must skip only
    // this one function's CFG, never drop the whole file's language group (R4).
    // eslint-disable-next-line no-console
    console.warn(`[cfg] Python buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** Whether a node is a Python function this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return PY_FUNCTION_TYPES.has(node.type);
}

/** The Python CFG visitor. */
export function createPythonCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { PY_FUNCTION_TYPES };
