/**
 * Ruby CfgVisitor (PDG layer beyond the C-family). Structurally closest to the
 * Python visitor — keyword/indentation-free blocks delimited by `end`,
 * statement-modifier forms (`expr if c`, `expr while c`), a
 * begin/rescue/else/ensure exception model (ensure = finally, rescue = catch,
 * the `else` runs if no exception), and `case`/`when` + `case`/`in` pattern
 * matching with no fallthrough. Ruby adds a few wrinkles the other visitors do
 * not have: `if`/`case`/`begin` are EXPRESSIONS, a method body is itself an
 * implicit `begin` (its `body_statement` can carry trailing `rescue`/`ensure`),
 * blocks (`do … end` / `{ … }`) and lambdas are their own CFG-bearing closures,
 * and `until` inverts the loop sense of `while`.
 *
 * Walks a Ruby `method` / `singleton_method` / block / `lambda`'s tree-sitter
 * AST and drives the language-agnostic {@link CfgBuilder} to produce a
 * serializable {@link FunctionCfg}, plus a def/use harvest
 * ({@link RubyHarvester}) for the reaching-defs / CDG solvers. Structured like
 * the Python / Go visitors — a `visit_<node_type>` dispatch over the statement
 * taxonomy, driving a per-function {@link ControlFlowContext} for break/continue
 * (next ≈ continue, redo ≈ loop-back) and the begin/ensure finalizer chain. NO
 * call-site `sites[]` are harvested (taint substrate is a later step — see
 * ruby-harvest.ts).
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-ruby via the introspection probe before use (mandatory pre-step).
 * Ruby shapes pre-empted (verified by a real parse):
 *  - functions: `method` / `singleton_method` (fields `name`/`parameters`/`body`;
 *    `body` is a `body_statement`). Blocks: `do_block` (`body` = `body_statement`)
 *    / `block` (`body` = `block_body`); `lambda` (`->(){}`; `body` = a `block`
 *    wrapping a `block_body`). The `lambda { }` keyword form is a `call` to
 *    `lambda` carrying a `block` — its block is collected as its own function.
 *  - `if` / `unless` fields `condition`/`consequence`(`then`)/`alternative`; the
 *    `alternative` is a nested `elsif` (own `condition`/`consequence`/`alternative`)
 *    or a trailing `else`. `if_modifier` / `unless_modifier` fields `body`/`condition`.
 *  - `while` / `until` fields `condition`/`body`(`do`); `while_modifier` /
 *    `until_modifier` fields `body`/`condition`. `for` fields `pattern`/`value`
 *    (an `in` wrapping the iterable) / `body`(`do`).
 *  - `case` fields `value` + `when` children (fields `pattern` (repeatable) /
 *    `body`(`then`)) + a trailing `else`. `case_match` (the `case … in` form)
 *    has fields `value` +
 *    `clauses`(`in_clause`, fields `pattern`/`guard`?(`if_guard`)/`body`) + an
 *    `else` field. No fallthrough in either.
 *  - `begin` directly holds its protected statements then typed `rescue` /
 *    `else` / `ensure` children (no field names). `rescue` fields
 *    `exceptions`?(`exceptions`)/`variable`?(`exception_variable`)/`body`(`then`).
 *    A method `body_statement` can carry the SAME trailing `rescue`/`else`/`ensure`
 *    children (an implicit begin). `rescue_modifier` fields `body`/`handler`.
 *  - `return` / `next` / `break` hold an optional `argument_list` child;
 *    `redo` / `retry` / `yield` are leaf-ish (`yield` may hold an `argument_list`).
 *
 * Edge-kind contract (matches the existing visitors — RD/CDG consume these):
 *  - if/unless/elsif/else → `cond-true` / `cond-false` (unless inverts the
 *    senses — its body is the cond-false arm)
 *  - while/until/for → `cond-true` / `loop-back` / `cond-false`; `until` inverts
 *    (its body runs while the condition is FALSE), still modeled with the same
 *    edge kinds (the loop body is `cond-true`, the exit `cond-false`)
 *  - case/when, case/in → `switch-case` (no fallthrough — like Go / Python match)
 *  - begin/rescue → `throw` (every protected-region block → each rescue handler);
 *    ensure completion → `finally-return` / `finally-break` / `finally-continue`
 *  - return → `return`; `break` → `break`; `next` ≈ continue → `continue`;
 *    `redo` → `loop-back` (re-enters the loop/block body); a jump crossing an
 *    `ensure` threads through it
 *  - straight-line → `seq`
 *
 * Ruby-specific modeling decisions (documented approximations):
 *  - a method body is an implicit `begin`: its `body_statement`'s trailing
 *    `rescue`/`else`/`ensure` children are modeled exactly like a `begin`.
 *  - `ensure` runs on BOTH the normal exit and an exception (finally semantics);
 *    the `rescue`-less `begin`/method re-propagates the exception after ensure.
 *  - `loop do … end` is `xs.loop`-shaped only when written as `loop { }`; the
 *    bare `loop do … end` is a `call` to `loop` carrying a `do_block`. The block
 *    body becomes its OWN function CFG (a closure), which — like `while true` —
 *    must still keep EXIT reverse-reachable. Inside the block, the structural
 *    exit-escape edge is emitted (the block body's normal fall-off reaches its
 *    EXIT). At the CALL site, the `loop … end` is a normal straight-line call.
 *  - `while true` (and any loop with no statically-false exit) STILL emits the
 *    structural `header → loopExit` `cond-false` edge so EXIT stays
 *    reverse-reachable and the post-dominator / CDG pass is not silently skipped.
 *    The single highest-risk correctness property of the visitor.
 *  - `retry` re-enters the nearest enclosing `begin` (its protected body); the
 *    edge is a `loop-back` to that begin's entry. Outside a begin it routes to
 *    EXIT (single-exit preserved) — a documented approximation.
 *  - `redo` re-runs the current loop/block body without re-testing the condition
 *    — modeled as a `loop-back` to the loop's continue target.
 *  - `if`/`case`/`begin` are EXPRESSIONS in Ruby (they have a value); as
 *    STATEMENTS they are modeled as control constructs. As an `assignment` RHS
 *    (`x = if c then 1 else 2 end` / `x = case k … end`) they are ALSO modeled as
 *    control flow now — the arms branch and the LHS binds at the rejoin (#2205,
 *    see {@link visitBindBranch}). Remaining inline (the same gap Java still has):
 *    a branch nested deeper in an expression (`x = f(if c …)`, `x = (if c …) + 1`)
 *    and an `operator_assignment` RHS (`x ||= if c …`).
 *
 * Known limitations:
 *  - `yield` is a normal expression here (no suspend/resume edge to the block
 *    passed by the caller); the generator-style resumption flow is not modeled.
 *  - `retry`'s re-enter target is the nearest lexical `begin`; a `retry` reached
 *    from a `rescue` whose begin is not on the active handler stack falls back to
 *    EXIT (documented approximation, not faked).
 *  - expression-position `case`/`begin`/`if` arms are inline (see above).
 *  - Def/use harvest scope: see ruby-harvest.ts — `@x`/`@@x`/`$x`/constant and
 *    index/attribute writes are not scalar defs; nested block / lambda bodies are
 *    opaque in both directions.
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
import { RubyHarvester } from './ruby-harvest.js';

/** Ruby node types that own a CFG-bearing function/closure body. */
const RUBY_FUNCTION_TYPES = new Set(['method', 'singleton_method', 'do_block', 'block', 'lambda']);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if',
  'unless',
  'if_modifier',
  'unless_modifier',
  'while',
  'until',
  'while_modifier',
  'until_modifier',
  'for',
  'case',
  'case_match',
  'begin',
  'return',
  'break',
  'next',
  'redo',
  'retry',
  'body_statement',
  'block_body',
]);

/**
 * Value-position branch constructs (#2205). When one of these is an `assignment`
 * RHS (`x = if … / case …`) or a `return` value, it is modeled as control flow
 * (its arms carry control dependence) instead of coalescing inline. `if`/`unless`
 * always branch (the condition gates the then-arm even without `else`).
 */
const VALUE_BRANCH_EXPR_TYPES = new Set(['if', 'unless', 'case', 'case_match']);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/**
 * Per-function Ruby walk state. One instance per function so the
 * {@link ControlFlowContext}, the exception-handler stack, and the `begin`
 * re-enter stack (for `retry`) are scoped to that function and never leak.
 */
class RubyCfgWalk {
  private readonly cfc = new ControlFlowContext();
  /** Stack of exception-handler entry blocks (rescue / ensure) a raise jumps to. */
  private readonly handlers: number[] = [];
  /** Stack of nearest-enclosing `begin` protected-body entry blocks (for `retry`). */
  private readonly beginEntries: number[] = [];
  /**
   * For a block / lambda function (`do … end`, `{ … }`, `->(){}`), the body entry
   * a `redo` re-enters when there is no enclosing real loop. A bare block is
   * implicitly re-runnable by `redo`; set once the body's first block is known.
   */
  private blockRedoTarget: number | undefined;

  /** Record the block-function body entry that a bare `redo` re-enters. */
  setBlockRedoTarget(entry: number): void {
    this.blockRedoTarget = entry;
  }

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: RubyHarvester,
  ) {}

  /** Statements of a body node (`then`/`do`/`else`/`ensure`/`body_statement`/…), no comments. */
  private statementsOf(body: SyntaxNode): SyntaxNode[] {
    return body.namedChildren.filter((c) => c.type !== 'comment');
  }

  /** Visit a body that may be a wrapper (`then`/`do`/`block_body`/`body_statement`) or a single statement. */
  private visitBody(node: SyntaxNode | undefined | null): SeqResult {
    return this.builder.withNesting(() => {
      if (!node) return null;
      if (this.isBodyWrapper(node)) return this.visitSeq(this.statementsOf(node));
      return this.visitStmt(node);
    });
  }

  private isBodyWrapper(node: SyntaxNode): boolean {
    return (
      node.type === 'then' ||
      node.type === 'do' ||
      node.type === 'else' ||
      node.type === 'ensure' ||
      node.type === 'body_statement' ||
      node.type === 'block_body'
    );
  }

  /** Wire a sequence of statements, coalescing straight-line runs into blocks. */
  visitSeq(stmts: SyntaxNode[]): SeqResult {
    return this.builder.withNesting(() => {
      let entry: number | undefined;
      let dangling: number[] = [];
      let openSimple: number | undefined;

      for (const stmt of stmts) {
        // A value-position branch on an assignment RHS (`x = if …`) is NOT in
        // CONTROL_FLOW_TYPES (its node is `assignment`), so route it out of the
        // coalescing path explicitly so visitStmt models its arms (#2205).
        if (CONTROL_FLOW_TYPES.has(stmt.type) || this.isValueBranchAssignment(stmt)) {
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
      case 'if':
      case 'unless':
        return this.visitIf(stmt);
      case 'if_modifier':
      case 'unless_modifier':
        return this.visitIfModifier(stmt);
      case 'while':
      case 'until':
        return this.visitWhile(stmt);
      case 'while_modifier':
      case 'until_modifier':
        return this.visitWhileModifier(stmt);
      case 'for':
        return this.visitFor(stmt);
      case 'case':
        return this.visitCase(stmt);
      case 'case_match':
        return this.visitCaseMatch(stmt);
      case 'begin':
        return this.visitBegin(stmt);
      case 'return':
        return this.visitReturn(stmt);
      case 'break':
        return this.visitBreak(stmt);
      case 'next':
        return this.visitNext(stmt);
      case 'redo':
        return this.visitRedo(stmt);
      case 'retry':
        return this.visitRetry(stmt);
      case 'body_statement':
        return this.visitImplicitBegin(stmt);
      case 'block_body':
        return this.visitSeq(this.statementsOf(stmt));
      case 'assignment': {
        // `x = if c then a else b end` / `x = case … end` (#2205): model the RHS
        // branch as control flow and bind the LHS on the rejoin.
        const branch = this.assignmentBranch(stmt);
        if (branch) return this.visitBindBranch(stmt, branch);
        return this.visitSimple(stmt);
      }
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
   * `return [expr]` — threads through EVERY active `ensure` before EXIT.
   * (A value-position branch RETURN is handled the idiomatic Ruby way already:
   * `def f; if c then a else b end; end` is the implicit last-expression and is
   * modeled as statement position. Bare `return if … end` is not a clean
   * grammar shape — tree-sitter-ruby drops the value — so it stays a plain
   * return; the assignment carrier is the value-branch fix here, #2205.)
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

  /** `break [expr]` — exits the nearest loop/block; threads through any `ensure`. */
  private visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    const res = this.cfc.resolveBreak();
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'break');
    return { entry: idx, exits: [] };
  }

  /** `next [expr]` ≈ continue — re-tests the nearest loop header; threads `ensure`. */
  private visitNext(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    const res = this.cfc.resolveContinue();
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'continue');
    return { entry: idx, exits: [] };
  }

  /**
   * `redo` — re-run the current loop/block body WITHOUT re-evaluating the
   * condition. Modeled as a `loop-back` to the nearest loop's continue target
   * (the loop header in the visitor's model). Outside a loop it routes to EXIT.
   */
  private visitRedo(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    // A `redo` inside a real loop re-runs that loop's body (its continue target);
    // a `redo` inside a bare block re-enters the block body. Falls back to EXIT
    // when neither exists (single-exit preserved).
    const target = this.cfc.continueTarget() ?? this.blockRedoTarget;
    if (target !== undefined) this.builder.edge(idx, target, 'loop-back');
    else this.builder.edge(idx, this.builder.exitIndex, 'seq');
    return { entry: idx, exits: [] };
  }

  /**
   * `retry` — re-enter the nearest enclosing `begin`'s protected body. Modeled as
   * a `loop-back` to that begin's entry block. Outside any begin it routes to
   * EXIT (single-exit preserved) — a documented approximation.
   */
  private visitRetry(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const begin = this.beginEntries[this.beginEntries.length - 1];
    if (begin !== undefined) this.builder.edge(idx, begin, 'loop-back');
    else this.builder.edge(idx, this.builder.exitIndex, 'seq');
    return { entry: idx, exits: [] };
  }

  /**
   * `if cond … elsif cond … else …` and `unless cond … else …`. Ruby has no
   * nested-if else chain: an `if`/`unless` carries `condition`/`consequence`(then)
   * plus an optional `alternative` that is an `elsif` (its own
   * condition/consequence/alternative) or a trailing `else`. `unless` inverts the
   * sense — its consequence is the cond-FALSE arm.
   */
  /** The value-position branch on an `assignment` RHS (`x = if … / case …`), or
   *  undefined when the RHS is anything else (#2205). */
  private assignmentBranch(stmt: SyntaxNode): SyntaxNode | undefined {
    if (stmt.type !== 'assignment') return undefined;
    const right = stmt.childForFieldName('right');
    return right && VALUE_BRANCH_EXPR_TYPES.has(right.type) ? right : undefined;
  }

  /** Whether a statement is an `assignment` with a value-position-branch RHS —
   *  routes it out of `visitSeq`'s coalescing path so its arms are modeled. */
  private isValueBranchAssignment(stmt: SyntaxNode): boolean {
    return this.assignmentBranch(stmt) !== undefined;
  }

  /** Model a value-position `if`/`unless`/`case`/`case_match` as control flow,
   *  bypassing the statement/value-position distinction (#2205). */
  private visitBranchExpr(node: SyntaxNode): TraversalResult {
    switch (node.type) {
      case 'if':
      case 'unless':
        return this.visitIf(node);
      case 'case':
        return this.visitCase(node);
      case 'case_match':
        return this.visitCaseMatch(node);
      default:
        return this.visitSimple(node); // unreachable — guarded by VALUE_BRANCH_EXPR_TYPES
    }
  }

  /**
   * `x = if … / case …` (#2205): visit the RHS branch as control flow, then rejoin
   * its arms at a facts-only continuation carrying ONLY the LHS target def (the
   * condition + arm-value uses are already harvested onto the branch's blocks).
   * The arms are now control-dependent on the branch condition, and `x` is defined
   * at the join — mirrors the Rust visitor's value-position `let` handling.
   */
  private visitBindBranch(stmt: SyntaxNode, branch: SyntaxNode): TraversalResult {
    const res = this.visitBranchExpr(branch);
    const cont = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      '',
      'normal',
      this.harvest.assignmentDefFacts(stmt),
    );
    this.builder.connect(res.exits, cont, 'seq');
    return { entry: res.entry, exits: [cont] };
  }

  private visitIf(stmt: SyntaxNode): TraversalResult {
    const inverted = stmt.type === 'unless';
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const thenKind = inverted ? 'cond-false' : 'cond-true';
    const elseKind = inverted ? 'cond-true' : 'cond-false';

    const exits: number[] = [];
    const thenRes = this.visitBody(stmt.childForFieldName('consequence'));
    if (thenRes) {
      this.builder.edge(header, thenRes.entry, thenKind);
      exits.push(...thenRes.exits);
    } else {
      exits.push(header); // empty consequence — that path falls through
    }

    const alt = stmt.childForFieldName('alternative');
    if (alt) {
      const { exits: altExits } = this.visitIfAlternative(alt, header, elseKind);
      exits.push(...altExits);
    } else {
      exits.push(header); // no else — the complement path falls through to the join
    }

    return { entry: header, exits: [...new Set(exits)] };
  }

  /**
   * Thread an `if`/`unless` alternative: an `elsif` (its own condition chained on
   * the parent's false edge) or a trailing `else`. Returns the dangling exits.
   */
  private visitIfAlternative(
    alt: SyntaxNode,
    falseFrom: number,
    falseKind: 'cond-true' | 'cond-false',
  ): { exits: number[] } {
    const exits: number[] = [];
    if (alt.type === 'elsif') {
      const cond = alt.childForFieldName('condition') ?? alt;
      const elifHeader = this.builder.newBlock(
        startLineOf(alt),
        endLineOf(cond),
        cond.text,
        'normal',
        this.harvest.facts(cond),
      );
      this.builder.edge(falseFrom, elifHeader, falseKind);
      const thenRes = this.visitBody(alt.childForFieldName('consequence'));
      if (thenRes) {
        this.builder.edge(elifHeader, thenRes.entry, 'cond-true');
        exits.push(...thenRes.exits);
      } else {
        exits.push(elifHeader);
      }
      const nested = alt.childForFieldName('alternative');
      if (nested) {
        exits.push(...this.visitIfAlternative(nested, elifHeader, 'cond-false').exits);
      } else {
        exits.push(elifHeader); // elsif with no further alternative falls through
      }
    } else {
      // a trailing `else` (consumes the false path entirely).
      const elseRes = this.visitBody(alt);
      if (elseRes) {
        this.builder.edge(falseFrom, elseRes.entry, falseKind);
        exits.push(...elseRes.exits);
      } else {
        exits.push(falseFrom);
      }
    }
    return { exits };
  }

  /**
   * `expr if cond` / `expr unless cond` — the modifier statement-form. The body
   * runs on the taken branch; the complement falls straight through to the join.
   */
  private visitIfModifier(stmt: SyntaxNode): TraversalResult {
    const inverted = stmt.type === 'unless_modifier';
    const cond = stmt.childForFieldName('condition');
    const body = stmt.childForFieldName('body');
    const header = this.builder.newBlock(
      startLineOf(stmt),
      cond ? endLineOf(cond) : startLineOf(stmt),
      cond ? cond.text : stmt.text,
      'normal',
      cond ? this.harvest.facts(cond) : undefined,
    );
    const takenKind = inverted ? 'cond-false' : 'cond-true';
    const exits: number[] = [header]; // the complement path falls through

    const bodyRes = body ? this.visitStmt(body) : null;
    if (bodyRes) {
      this.builder.edge(header, bodyRes.entry, takenKind);
      exits.push(...bodyRes.exits);
    } else {
      this.builder.edge(header, header, takenKind === 'cond-true' ? 'cond-true' : 'cond-false');
    }
    return { entry: header, exits: [...new Set(exits)] };
  }

  /**
   * `while cond … end` / `until cond … end`. `until` inverts (its body runs while
   * the condition is FALSE); both are modeled with `cond-true` to the body and
   * `cond-false` to the loop exit (the inversion is a semantic note, not a
   * structural change — the header is a single control point either way).
   */
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
    const body = this.visitBody(stmt.childForFieldName('body'));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-tests
    }
    // Always emit the structural exit edge — even `while true` keeps EXIT
    // reverse-reachable for the post-dominator / CDG pass.
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  /** `expr while cond` / `expr until cond` — the modifier loop-form. */
  private visitWhileModifier(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const body = stmt.childForFieldName('body');
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, []);
    const bodyRes = body ? this.visitStmt(body) : null;
    this.cfc.pop();

    if (bodyRes) {
      this.builder.edge(header, bodyRes.entry, 'cond-true');
      this.builder.connect(bodyRes.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back');
    }
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  /**
   * `for PATTERN in VALUE … end`. Header = the iteration test (a def of the
   * pattern target(s) + a use of the iterable).
   */
  private visitFor(stmt: SyntaxNode): TraversalResult {
    const value = stmt.childForFieldName('value');
    const header = this.builder.newBlock(
      startLineOf(stmt),
      value ? endLineOf(value) : startLineOf(stmt),
      this.forHeaderText(stmt),
      'normal',
      this.harvest.loopHeadFacts(stmt),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, []);
    const body = this.visitBody(stmt.childForFieldName('body'));
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

  private forHeaderText(stmt: SyntaxNode): string {
    const pattern = stmt.childForFieldName('pattern')?.text ?? '';
    const value = stmt.childForFieldName('value')?.text ?? '';
    return pattern || value ? `for ${pattern} ${value}` : stmt.text.split('\n')[0];
  }

  /**
   * `case VALUE; when P; … else; … end`. Cases do NOT fall through (like Go /
   * Python match). The subject block fans a `switch-case` edge to each `when`
   * body; a `case` with no `else` also reaches the join directly (no-match path),
   * keeping EXIT reverse-reachable.
   */
  private visitCase(stmt: SyntaxNode): TraversalResult {
    const value = stmt.childForFieldName('value');
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      value ? endLineOf(value) : startLineOf(stmt),
      value ? `case ${value.text}` : 'case',
      'normal',
      value ? this.harvest.facts(value) : undefined,
    );
    const caseExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    const whenClauses = stmt.namedChildren.filter((c) => c.type === 'when');
    const elseClause = stmt.namedChildren.find((c) => c.type === 'else');

    // Each `when` pattern evaluates conditionally before its body — harvest its
    // uses onto the dispatch block (a later case only tests when earlier
    // patterns did not match).
    for (const w of whenClauses) {
      for (const pat of this.whenPatterns(w)) {
        this.builder.attachFacts(dispatch, this.harvest.factsConditional(pat));
      }
    }

    this.cfc.pushSwitch(caseExit, []);
    for (const w of whenClauses) {
      const bodyRes = this.visitBody(w.childForFieldName('body'));
      const entry = bodyRes?.entry ?? caseExit;
      this.builder.edge(dispatch, entry, 'switch-case');
      if (bodyRes) this.builder.connect(bodyRes.exits, caseExit, 'seq');
    }
    if (elseClause) {
      const elseRes = this.visitBody(elseClause);
      const entry = elseRes?.entry ?? caseExit;
      this.builder.edge(dispatch, entry, 'switch-case');
      if (elseRes) this.builder.connect(elseRes.exits, caseExit, 'seq');
    } else {
      // No `else` → a no-match path reaches the exit directly (keeps EXIT
      // reverse-reachable even when every when body jumps).
      this.builder.edge(dispatch, caseExit, 'switch-case');
    }
    this.cfc.pop();

    return { entry: dispatch, exits: [caseExit] };
  }

  /** The `pattern`-field children of a `when` clause (a `when` may list several). */
  private whenPatterns(whenClause: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let i = 0; i < whenClause.childCount; i++) {
      if (whenClause.fieldNameForChild(i) === 'pattern') {
        const c = whenClause.child(i);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /**
   * `case VALUE; in PATTERN [if guard]; … else; … end` — the pattern-matching
   * form (`case_match`). Same no-fallthrough dispatch as `case`/`when`; each
   * `in_clause` body is dispatched with a `switch-case` edge and an `in_clause`
   * guard is harvested as a conditional use on the dispatch.
   */
  private visitCaseMatch(stmt: SyntaxNode): TraversalResult {
    const value = stmt.childForFieldName('value');
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      value ? endLineOf(value) : startLineOf(stmt),
      value ? `case ${value.text}` : 'case',
      'normal',
      value ? this.harvest.facts(value) : undefined,
    );
    const caseExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    const clauses = stmt.namedChildren.filter((c) => c.type === 'in_clause');
    const elseClause =
      stmt.childForFieldName('else') ?? stmt.namedChildren.find((c) => c.type === 'else');

    // An `in`-clause guard (`in P if g`) evaluates conditionally on the dispatch.
    for (const c of clauses) {
      const guard = c.childForFieldName('guard');
      if (guard) this.builder.attachFacts(dispatch, this.harvest.factsConditional(guard));
    }

    this.cfc.pushSwitch(caseExit, []);
    for (const c of clauses) {
      const bodyRes = this.visitBody(c.childForFieldName('body'));
      const entry = bodyRes?.entry ?? caseExit;
      this.builder.edge(dispatch, entry, 'switch-case');
      if (bodyRes) this.builder.connect(bodyRes.exits, caseExit, 'seq');
    }
    if (elseClause) {
      const elseRes = this.visitBody(elseClause);
      const entry = elseRes?.entry ?? caseExit;
      this.builder.edge(dispatch, entry, 'switch-case');
      if (elseRes) this.builder.connect(elseRes.exits, caseExit, 'seq');
    } else {
      // A `case … in` with no `else` raises NoMatchingPatternError on no match,
      // but the structural no-match edge keeps EXIT reverse-reachable.
      this.builder.edge(dispatch, caseExit, 'switch-case');
    }
    this.cfc.pop();

    return { entry: dispatch, exits: [caseExit] };
  }

  /**
   * `begin … [rescue …]* [else …] [ensure …] end`. Mirrors the Python
   * try-route-through:
   *  - `ensure` runs on every exit (normal, exception, early jumps) — a finalizer
   *    frame for early-exit threading + a normal/exceptional join.
   *  - each `rescue` handler catches from the protected body.
   *  - `else` runs only if the body completed with no exception.
   */
  private visitBegin(stmt: SyntaxNode): SeqResult {
    const children = this.statementsOf(stmt);
    return this.buildProtected(stmt, children);
  }

  /**
   * A method `body_statement` is an implicit `begin` — its trailing
   * `rescue`/`else`/`ensure` children behave exactly like a `begin`'s. When there
   * are none, this is just a straight statement sequence.
   */
  private visitImplicitBegin(stmt: SyntaxNode): SeqResult {
    const children = this.statementsOf(stmt);
    const hasHandlers = children.some(
      (c) => c.type === 'rescue' || c.type === 'else' || c.type === 'ensure',
    );
    if (!hasHandlers) return this.visitSeq(children);
    return this.buildProtected(stmt, children);
  }

  /**
   * Shared begin/rescue/else/ensure builder. `children` is the construct's
   * ordered named children: leading protected statements, then the typed
   * `rescue` / `else` / `ensure` clauses.
   */
  private buildProtected(span: SyntaxNode, children: SyntaxNode[]): SeqResult {
    const protectedStmts: SyntaxNode[] = [];
    const rescueClauses: SyntaxNode[] = [];
    let elseClause: SyntaxNode | undefined;
    let ensureClause: SyntaxNode | undefined;
    for (const c of children) {
      if (c.type === 'rescue') rescueClauses.push(c);
      else if (c.type === 'else') elseClause = c;
      else if (c.type === 'ensure') ensureClause = c;
      else protectedStmts.push(c);
    }

    // Build ensure first — it is both a normal join and a handler target. It runs
    // OUTSIDE this begin's finalizer frame (a return inside ensure threads only
    // OUTER ensures).
    const ensureRes = ensureClause ? this.visitSeq(this.statementsOf(ensureClause)) : null;
    const finFrame = ensureRes ? this.cfc.pushFinalizer(ensureRes.entry) : null;

    // Pre-create each rescue's facts-only HEAD block (`rescue Exc => e` binds `e`
    // once, on handler entry) so the protected body knows its handler target
    // BEFORE either body is walked — this lets a `retry` inside a rescue handler
    // re-enter the protected body's real entry (which is walked next).
    const handlerEntries = rescueClauses.map((clause) =>
      this.builder.newBlock(
        startLineOf(clause),
        startLineOf(clause),
        '',
        'normal',
        this.harvest.rescueHeadFacts(clause),
      ),
    );

    // Handler for the protected body: the first rescue if present, else ensure,
    // else the outer handler.
    const tryHandler = handlerEntries[0] ?? ensureRes?.entry ?? this.currentHandler();
    const protectedStart = this.builder.blockCount;
    this.handlers.push(tryHandler);
    const bodyRes = this.visitSeq(protectedStmts);
    this.handlers.pop();
    // Block range covering ONLY the protected body (rescue handler bodies are
    // walked afterward and must NOT get the conservative per-block throw edge).
    const protectedEnd = this.builder.blockCount;

    // The protected body's entry is where a `retry` re-enters (a `loop-back`).
    // Push it for BOTH the rescue-handler bodies AND already-walked body (already
    // done above — a `retry` in the body itself is a non-idiom, but harmless).
    const beginEntry = bodyRes?.entry ?? handlerEntries[0] ?? this.builder.exitIndex;
    this.beginEntries.push(beginEntry);

    // Walk each rescue handler body now (within the begin-entry scope so a
    // `retry` re-enters the protected body). A raise inside a handler propagates
    // to ensure (if any), else the outer handler.
    const handlerExits: number[] = [];
    rescueClauses.forEach((clause, i) => {
      if (ensureRes) this.handlers.push(ensureRes.entry);
      const headBlock = handlerEntries[i];
      const handlerBodyRes = this.visitBody(clause.childForFieldName('body'));
      if (handlerBodyRes) {
        this.builder.edge(headBlock, handlerBodyRes.entry, 'seq');
        handlerExits.push(...handlerBodyRes.exits);
      } else {
        handlerExits.push(headBlock); // empty handler — header is the exit
      }
      if (ensureRes) this.handlers.pop();
    });

    this.beginEntries.pop();

    // Conservative exceptional edges: ANY protected-region block may raise to
    // EACH handler (an unmatched exception type tries the next handler).
    if (rescueClauses.length > 0 || ensureClause) {
      const targets =
        handlerEntries.length > 0 ? handlerEntries : ensureRes ? [ensureRes.entry] : [];
      for (let b = protectedStart; b < protectedEnd; b++) {
        for (const h of targets) this.builder.edge(b, h, 'throw');
      }
    }

    // The `else` runs only on no-exception normal completion of the body.
    let normalAfterBody: number[] = bodyRes ? [...bodyRes.exits] : [];
    if (elseClause) {
      const elseRes = this.visitBody(elseClause);
      if (elseRes && bodyRes) {
        this.builder.connect(bodyRes.exits, elseRes.entry, 'seq');
        normalAfterBody = [...elseRes.exits];
      } else if (elseRes) {
        normalAfterBody = [...elseRes.exits];
      }
    }

    // Close the finalizer frame; wire crossing-jump completion legs.
    if (finFrame && ensureRes) {
      this.cfc.pop();
      drainFinalizerPending(this.builder, finFrame, ensureRes.exits);
    }

    const exits: number[] = [];
    if (ensureRes) {
      // Normal completion of (body→else) AND each handler flows through ensure.
      this.builder.connect(normalAfterBody, ensureRes.entry, 'seq');
      this.builder.connect(handlerExits, ensureRes.entry, 'seq');
      exits.push(...ensureRes.exits);
      // A begin with no rescue → an uncaught exception re-propagates after ensure.
      if (handlerEntries.length === 0) {
        this.builder.connect(ensureRes.exits, this.currentHandler(), 'throw');
      }
    } else {
      exits.push(...normalAfterBody);
      exits.push(...handlerExits);
    }

    const entry = bodyRes?.entry ?? ensureRes?.entry ?? handlerEntries[0];
    if (entry === undefined) {
      void span;
      return null;
    }
    return { entry, exits: [...new Set(exits)] };
  }

  /** Nearest enclosing exception handler, or the function EXIT. */
  private currentHandler(): number {
    return this.handlers.length ? this.handlers[this.handlers.length - 1] : this.builder.exitIndex;
  }
}

/** The body node of a Ruby function/block/lambda (a `block` for `lambda` unwraps once). */
function functionBody(fnNode: SyntaxNode): SyntaxNode | undefined {
  const body = fnNode.childForFieldName('body');
  if (!body) return undefined;
  // A `lambda`'s `body` is a `block` wrapping a `block_body` — unwrap to the
  // inner body so the walk sees the statement sequence.
  if (fnNode.type === 'lambda' && body.type === 'block') {
    return body.childForFieldName('body') ?? body;
  }
  return body;
}

/** Build the CFG for one Ruby function/block/lambda node, or `undefined` if not modelable. */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  try {
    if (!RUBY_FUNCTION_TYPES.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    const body = functionBody(fnNode);
    if (!body) {
      // No body — an empty `def f; end` still gets a trivial ENTRY → EXIT CFG so
      // it is not silently dropped.
      const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
      const harvest = new RubyHarvester(fnNode);
      const paramFacts = harvest.paramFacts();
      if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);
      builder.edge(builder.entryIndex, builder.exitIndex, 'seq');
      return builder.finish(harvest.bindingTable());
    }

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new RubyHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    const walk = new RubyCfgWalk(builder, harvest);
    // For a bare block / lambda, a `redo` re-enters the block body. The body's
    // first block is the NEXT index the builder will allocate (entry + exit are
    // already taken). Set it so a top-level `redo` inside the block loops back.
    if (fnNode.type !== 'method' && fnNode.type !== 'singleton_method') {
      walk.setBlockRedoTarget(builder.blockCount);
    }
    const res = walk.visitStmt(body);
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
    console.warn(`[cfg] Ruby buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** Whether a node is a Ruby function/closure this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return RUBY_FUNCTION_TYPES.has(node.type);
}

/** The Ruby CFG visitor. */
export function createRubyCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { RUBY_FUNCTION_TYPES };
