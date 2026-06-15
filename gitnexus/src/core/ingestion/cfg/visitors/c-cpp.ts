/**
 * C / C++ CfgVisitor (#2195 U2, plan KTD1).
 *
 * Walks a C or C++ function's tree-sitter AST and drives the language-agnostic
 * {@link CfgBuilder} to produce a serializable {@link FunctionCfg}, plus a
 * def/use harvest ({@link CCppHarvester}) for the reaching-defs / CDG solvers.
 *
 * SHARED CORE, TWO FACTORIES. A grammar-introspection probe (mandatory pre-step,
 * KTD1) confirmed every control-flow node type and field this visitor uses is
 * IDENTICAL between tree-sitter-c and tree-sitter-cpp — `if_statement`,
 * `for_statement`, `while_statement`, `do_statement`, `switch_statement` /
 * `case_statement`, `return`/`break`/`continue`/`goto_statement` /
 * `labeled_statement`, `compound_statement`, and the `condition`/`consequence`/
 * `alternative`/`initializer`/`update`/`body`/`label`/`value` fields. So the C
 * walk ({@link CCfgWalk}) is grammar-shared, and C++ EXTENDS it ({@link
 * CppCfgWalk}) with exception flow (`try_statement` / `catch_clause` /
 * `throw_statement`) and `for_range_loop` — node types that simply never occur
 * in a C parse, so there is no `if (lang === …)` branching (AGENTS.md
 * no-language-naming rule). The two factories differ only in which walk class
 * and function-node set they install.
 *
 * Edge-kind contract (matches the TS visitor — RD/CDG consume these):
 *  - if/else → `cond-true` / `cond-false`
 *  - loops (for / while / do-while / for-range) → `cond-true` / `loop-back` /
 *    `cond-false`
 *  - switch → `switch-case` / `fallthrough` (C-style: a case body that does not
 *    `break` falls into the next case)
 *  - try/catch (C++) → `throw` (every protected-region block → the handler)
 *  - return / throw / break / continue → the matching terminator kind
 *  - straight-line → `seq`
 *
 * Classic hazards, handled explicitly:
 *  - loops allocate a dedicated loop-exit block so `break` has a target before
 *    the loop's successor is known; `continue` targets the header/increment.
 *  - `for (;;) {}` / `while (1) {}` still emit the structural `header → loopExit`
 *    `cond-false` escape edge so EXIT stays reverse-reachable from every block —
 *    the post-dominator / CDG pass is unsound otherwise (it silently emits zero
 *    CDG for the function).
 *  - C `goto`/`labeled_statement`: labels resolve within the function (forward
 *    AND backward); an unresolved `goto` (label not in this function) routes to
 *    EXIT and logs via the builder warn path, preserving single-exit.
 *  - C++ `try`/`catch`: conservative exceptional flow — EVERY block in the
 *    protected region edges to the handler (an exception may fire mid-block),
 *    matching the TS `visitTry` over-approximation. A `throw` with no enclosing
 *    try routes to EXIT.
 *
 * Known limitations:
 *  - C++ RAII: a destructor runs implicitly at scope exit, but tree-sitter does
 *    NOT represent that call in the AST. This visitor therefore does NOT model
 *    destructor-at-scope-exit control/data flow — it is a documented gap, not
 *    faked. (C++ has no `finally`; `try`/`catch` is the only modeled exception
 *    construct, so the TS finalizer-frame machinery is unused here.)
 *  - A `goto` whose label is undefined in the function keeps the conservative
 *    route-to-EXIT fallback (single-exit preserved; the continuation path is
 *    approximate). `setjmp`/`longjmp` non-local control is not modeled.
 *  - Computed `goto` (`goto *ptr;`, a GNU extension) has no static label target
 *    and routes to EXIT like an unresolved label.
 *  - Def/use harvest scope: see `c-cpp-harvest.ts` — member/pointer/array writes
 *    are not scalar defs; C++ lambda bodies are opaque in both directions.
 *
 * Returns `undefined` (never throws) for an AST shape it cannot model, so a
 * malformed function never drops the whole file's CFG group (R4).
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import type { TraversalResult } from '../traversal-result.js';
import type { CfgVisitor, FunctionCfg } from '../types.js';
import { CCppHarvester } from './c-cpp-harvest.js';

/** C function node — only `function_definition` owns a CFG-bearing body. */
const C_FUNCTION_TYPES = new Set(['function_definition']);
/** C++ adds the lambda as a CFG-bearing function. */
const CPP_FUNCTION_TYPES = new Set(['function_definition', 'lambda_expression']);

/** Statement node types that break a basic block (everything else coalesces). */
const C_CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'switch_statement',
  'return_statement',
  'break_statement',
  'continue_statement',
  'goto_statement',
  'labeled_statement',
  'compound_statement',
]);

/** C++ control-flow node types (C set ∪ exceptions ∪ range-for). */
const CPP_CONTROL_FLOW_TYPES = new Set([
  ...C_CONTROL_FLOW_TYPES,
  'for_range_loop',
  'try_statement',
  'throw_statement',
  'co_return_statement',
]);

const LOOP_OR_SWITCH_TYPES = new Set([
  'while_statement',
  'do_statement',
  'for_statement',
  'for_range_loop',
  'switch_statement',
]);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/** A `break`/`continue` jump-target frame (loop or switch). */
interface JumpFrame {
  readonly kind: 'loop' | 'switch';
  /** Where a `break` jumps to (loop exit / switch exit). */
  readonly breakTo: number;
  /** Where a `continue` jumps to (loop header / increment). -1 for a switch. */
  readonly continueTo: number;
}

/**
 * Per-function C walk state. One instance per function so the jump-target stack,
 * exception-handler stack, and label tables are scoped to that function.
 *
 * Designed to be EXTENDED by the C++ walk: the dispatch table is open via the
 * protected {@link visitStmt} override hook, so C++ adds its node types without
 * any language conditional in the C core.
 */
class CCfgWalk {
  protected readonly jumps: JumpFrame[] = [];
  /** Stack of exception-handler entry blocks (catch) a `throw` jumps to. */
  protected readonly handlers: number[] = [];
  /** label name → its `labeled_statement` body's entry block (resolved on demand). */
  protected readonly labelBlocks = new Map<string, number>();
  /** Pending gotos to a label not yet seen: label → list of source blocks. */
  protected readonly pendingGotos = new Map<string, number[]>();
  /** Set of node types that break a block, used by {@link visitSeq}. */
  protected readonly controlFlowTypes: ReadonlySet<string>;

  constructor(
    protected readonly builder: CfgBuilder,
    protected readonly harvest: CCppHarvester,
    controlFlowTypes: ReadonlySet<string>,
  ) {
    this.controlFlowTypes = controlFlowTypes;
  }

  /** Statements of a block node, ignoring comments. */
  protected statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter((c) => c.type !== 'comment');
  }

  /** The `body` block of a node (field, or the first compound_statement child). */
  protected bodyBlockOf(node: SyntaxNode): SyntaxNode | undefined {
    return (
      node.childForFieldName('body') ??
      node.namedChildren.find((c) => c.type === 'compound_statement')
    );
  }

  /** Visit a body that may be a `compound_statement` or a single statement. */
  protected visitBody(node: SyntaxNode | undefined | null): SeqResult {
    return this.builder.withNesting(() => {
      if (!node) return null;
      if (node.type === 'compound_statement') return this.visitSeq(this.statementsOf(node));
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
        if (this.controlFlowTypes.has(stmt.type)) {
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
      case 'while_statement':
        return this.visitWhile(stmt);
      case 'do_statement':
        return this.visitDoWhile(stmt);
      case 'for_statement':
        return this.visitFor(stmt);
      case 'switch_statement':
        return this.visitSwitch(stmt);
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
      case 'compound_statement':
        return this.visitSeq(this.statementsOf(stmt));
      default:
        return this.visitExtra(stmt) ?? this.visitSimple(stmt);
    }
  }

  /**
   * Extension hook for node types the C core does not handle (C++ try/catch/
   * throw/for-range). Returns `undefined` to fall through to {@link visitSimple}.
   * The C core has none, so this is a no-op here.
   */
  protected visitExtra(_stmt: SyntaxNode): SeqResult | undefined {
    return undefined;
  }

  protected visitSimple(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    return { entry: idx, exits: [idx] };
  }

  protected visitReturn(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    this.builder.edge(idx, this.builder.exitIndex, 'return');
    return { entry: idx, exits: [] };
  }

  protected visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const target = this.nearestBreakTarget();
    this.builder.edge(idx, target ?? this.builder.exitIndex, 'break');
    return { entry: idx, exits: [] };
  }

  protected visitContinue(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const target = this.nearestContinueTarget();
    this.builder.edge(idx, target ?? this.builder.exitIndex, 'continue');
    return { entry: idx, exits: [] };
  }

  /** Nearest enclosing loop/switch `break` target, or undefined (→ EXIT). */
  private nearestBreakTarget(): number | undefined {
    return this.jumps.length ? this.jumps[this.jumps.length - 1].breakTo : undefined;
  }

  /** Nearest enclosing loop `continue` target (switches don't catch continue). */
  private nearestContinueTarget(): number | undefined {
    for (let i = this.jumps.length - 1; i >= 0; i--) {
      if (this.jumps[i].kind === 'loop') return this.jumps[i].continueTo;
    }
    return undefined;
  }

  /** `goto label;` — route to the label block if known, else defer / EXIT. */
  protected visitGoto(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const label = this.labelOf(stmt);
    if (label === undefined) {
      // Computed goto (`goto *p;`) or malformed — route to EXIT (single-exit).
      this.builder.edge(idx, this.builder.exitIndex, 'seq');
      return { entry: idx, exits: [] };
    }
    const target = this.labelBlocks.get(label);
    if (target !== undefined) {
      this.builder.edge(idx, target, 'seq'); // backward goto: label already built
    } else {
      // Forward goto — wire once the label is created (or to EXIT at finish()).
      const list = this.pendingGotos.get(label);
      if (list) list.push(idx);
      else this.pendingGotos.set(label, [idx]);
    }
    return { entry: idx, exits: [] };
  }

  protected visitLabeled(stmt: SyntaxNode): SeqResult {
    const label = this.labelOf(stmt);
    // The labeled statement's body is the trailing named child (no `body` field
    // on labeled_statement in C/C++).
    const body =
      stmt.namedChildren.find((c) => c.type !== 'statement_identifier' && c.type !== 'comment') ??
      null;
    const res = this.visitBody(body);
    if (label !== undefined) {
      const entry = res?.entry ?? this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');
      this.labelBlocks.set(label, entry);
      // Resolve any forward gotos that were waiting on this label.
      const pending = this.pendingGotos.get(label);
      if (pending) {
        for (const from of pending) this.builder.edge(from, entry, 'seq');
        this.pendingGotos.delete(label);
      }
      if (!res) return { entry, exits: [entry] };
    }
    return res;
  }

  protected visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const condBlock = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const exits: number[] = [];

    const thenRes = this.visitBody(stmt.childForFieldName('consequence'));
    if (thenRes) {
      this.builder.edge(condBlock, thenRes.entry, 'cond-true');
      exits.push(...thenRes.exits);
    } else {
      exits.push(condBlock); // empty then — true path falls through
    }

    const elseNode = this.elseBodyOf(stmt);
    if (elseNode) {
      const elseRes = this.visitBody(elseNode);
      if (elseRes) {
        this.builder.edge(condBlock, elseRes.entry, 'cond-false');
        exits.push(...elseRes.exits);
      } else {
        exits.push(condBlock);
      }
    } else {
      exits.push(condBlock); // no else — false path falls through to the join
    }

    return { entry: condBlock, exits: [...new Set(exits)] };
  }

  /** The else body node (unwraps an `else_clause` wrapper if present). */
  private elseBodyOf(ifStmt: SyntaxNode): SyntaxNode | undefined {
    const alt = ifStmt.childForFieldName('alternative');
    if (!alt) return undefined;
    if (alt.type === 'else_clause') {
      return alt.childForFieldName('body') ?? alt.namedChildren[0];
    }
    return alt; // an `else if` is the nested if_statement directly
  }

  protected visitWhile(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.jumps.push({ kind: 'loop', breakTo: loopExit, continueTo: header });
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.jumps.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-tests
    }
    // Always emit the structural exit edge — even `while (1)` keeps EXIT
    // reverse-reachable for the post-dominator / CDG pass.
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  protected visitDoWhile(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const condBlock = this.builder.newBlock(
      startLineOf(cond),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.jumps.push({ kind: 'loop', breakTo: loopExit, continueTo: condBlock });
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.jumps.pop();

    const backTarget = body ? body.entry : condBlock;
    if (body) this.builder.connect(body.exits, condBlock, 'seq');
    this.builder.edge(condBlock, backTarget, 'loop-back'); // cond true → run body again
    this.builder.edge(condBlock, loopExit, 'cond-false');
    return { entry: backTarget, exits: [loopExit] };
  }

  protected visitFor(stmt: SyntaxNode): TraversalResult {
    const init = stmt.childForFieldName('initializer');
    const cond = stmt.childForFieldName('condition');
    const incr = stmt.childForFieldName('update');

    const header = this.builder.newBlock(
      startLineOf(stmt),
      cond ? endLineOf(cond) : startLineOf(stmt),
      cond ? cond.text : 'for(;;)',
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

    this.jumps.push({ kind: 'loop', breakTo: loopExit, continueTo: incrBlock });
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.jumps.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, incrBlock, incr ? 'seq' : 'loop-back');
    } else {
      this.builder.edge(header, incrBlock, 'cond-true');
      if (!incr) this.builder.edge(header, header, 'loop-back');
    }
    // Structural exit edge — `for (;;) {}` (no condition) still keeps EXIT
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

  protected visitSwitch(stmt: SyntaxNode): TraversalResult {
    const value = stmt.childForFieldName('condition') ?? stmt;
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(value),
      value.text,
      'normal',
      this.harvest.facts(value),
    );
    const switchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.jumps.push({ kind: 'switch', breakTo: switchExit, continueTo: -1 });
    const body = stmt.childForFieldName('body');
    // C/C++ uses ONE `case_statement` node for both `case X:` and `default:`;
    // a default has no `value` field.
    const cases = body ? body.namedChildren.filter((c) => c.type === 'case_statement') : [];

    // `case X:` test expressions live in no block — harvest their uses onto the
    // dispatch block as may-defs/uses (sound over-approx of in-order evaluation).
    for (const c of cases) {
      const caseValue = c.childForFieldName('value');
      if (caseValue) this.builder.attachFacts(dispatch, this.harvest.factsConditional(caseValue));
    }

    const caseResults = cases.map((c) => this.visitSeq(this.caseStatements(c)));
    const hasDefault = cases.some((c) => !c.childForFieldName('value'));

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

    for (let i = 0; i < cases.length; i++) {
      const res = caseResults[i];
      if (!res) continue;
      const fallTarget = i + 1 < cases.length ? entryOf[i + 1] : switchExit;
      this.builder.connect(res.exits, fallTarget, 'fallthrough');
    }

    this.jumps.pop();
    return { entry: dispatch, exits: [switchExit] };
  }

  /** A case's body statements (everything but the `value` test and comments). */
  private caseStatements(caseNode: SyntaxNode): SyntaxNode[] {
    const value = caseNode.childForFieldName('value');
    return caseNode.namedChildren.filter((c) => c.id !== value?.id && c.type !== 'comment');
  }

  /** Nearest enclosing exception handler, or the function EXIT. */
  protected currentHandler(): number {
    return this.handlers.length ? this.handlers[this.handlers.length - 1] : this.builder.exitIndex;
  }

  private labelOf(stmt: SyntaxNode): string | undefined {
    const id =
      stmt.childForFieldName('label') ??
      stmt.namedChildren.find((c) => c.type === 'statement_identifier');
    return id?.text;
  }

  /**
   * Drain any forward gotos whose label never appeared in the function (a label
   * defined in a header macro, or malformed source) — route them to EXIT so the
   * graph stays single-exit. Logs via console.warn (the builder's warn path)
   * so a dropped jump is never silent (R4). Called once after the body walk.
   */
  finishGotos(): void {
    for (const [label, froms] of this.pendingGotos) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cfg] unresolved goto label "${label}" routed to EXIT (${froms.length} site(s))`,
      );
      for (const from of froms) this.builder.edge(from, this.builder.exitIndex, 'seq');
    }
    this.pendingGotos.clear();
  }
}

/**
 * C++ walk — extends the C core with exception flow and the range-for loop.
 * These node types never appear in a C parse, so no language conditional is
 * needed; the C core dispatches them through {@link visitExtra}.
 */
class CppCfgWalk extends CCfgWalk {
  protected override visitExtra(stmt: SyntaxNode): SeqResult | undefined {
    switch (stmt.type) {
      case 'for_range_loop':
        return this.visitForRange(stmt);
      case 'try_statement':
        return this.visitTry(stmt);
      case 'throw_statement':
        return this.visitThrow(stmt);
      case 'co_return_statement':
        // A coroutine `co_return` terminates the coroutine like an ordinary
        // return: edge to EXIT, no fallthrough (`co_await`/`co_yield` are plain
        // expressions that continue, so they need no control-flow handling).
        return this.visitReturn(stmt);
      default:
        return undefined;
    }
  }

  private visitThrow(stmt: SyntaxNode): TraversalResult {
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

  private visitForRange(stmt: SyntaxNode): TraversalResult {
    // Header text is synthesized; facts come from the declarator (def) + the
    // iterated expression (use) directly.
    const header = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      this.forRangeHeaderText(stmt),
      'normal',
      this.harvest.forRangeHeadFacts(stmt),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.jumps.push({ kind: 'loop', breakTo: loopExit, continueTo: header });
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.jumps.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back');
    }
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private forRangeHeaderText(stmt: SyntaxNode): string {
    const decl = stmt.childForFieldName('declarator')?.text ?? '';
    const right = stmt.childForFieldName('right')?.text ?? '';
    return decl || right ? `for(${decl} : ${right})` : 'for(… : …)';
  }

  /**
   * try / catch (C++ has no `finally`). Conservative exceptional flow: every
   * block created while walking the protected body edges to the (first) catch
   * handler — an exception may fire mid-block, and a branched body must still
   * reach the handler from any interior block (matching the TS visitTry
   * over-approximation). Multiple `catch` clauses: a body throw routes to EVERY
   * handler (the runtime type match is dynamic), and each handler's normal
   * completion joins the post-try continuation.
   */
  private visitTry(stmt: SyntaxNode): SeqResult {
    const bodyNode = stmt.childForFieldName('body');
    const catchClauses: SyntaxNode[] = [];
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const c = stmt.namedChild(i);
      if (c?.type === 'catch_clause') catchClauses.push(c);
    }

    // Build each catch handler. The handler entry is the catch-param binding
    // block (a facts-only block) in front of the body, so the exception's
    // binding happens exactly once on handler entry.
    const handlerEntries: number[] = [];
    const handlerExits: number[] = [];
    for (const clause of catchClauses) {
      const clauseBody = this.bodyBlockOf(clause);
      let res: SeqResult = clauseBody ? this.visitSeq(this.statementsOf(clauseBody)) : null;
      if (res === null) {
        // Empty catch body still CATCHES — synthesize one block so the
        // exception lands somewhere and the post-try code stays reachable.
        const idx = this.builder.newBlock(startLineOf(clause), endLineOf(clause), '');
        res = { entry: idx, exits: [idx] };
      }
      const paramFacts = this.harvest.catchParamFacts(clause);
      if (paramFacts) {
        const paramBlock = this.builder.newBlock(
          startLineOf(clause),
          startLineOf(clause),
          '',
          'normal',
          paramFacts,
        );
        this.builder.edge(paramBlock, res.entry, 'seq');
        res = { entry: paramBlock, exits: res.exits };
      }
      handlerEntries.push(res.entry);
      handlerExits.push(...res.exits);
    }

    // The protected body's handler is the FIRST catch (if any), else the outer.
    const tryHandler = handlerEntries[0] ?? this.currentHandler();
    const protectedStart = this.builder.blockCount;
    this.handlers.push(tryHandler);
    const bodyRes = bodyNode ? this.visitSeq(this.statementsOf(bodyNode)) : null;
    this.handlers.pop();

    // Conservative exceptional edges: every protected-region block → EVERY handler
    // entry. The runtime catch that matches a thrown type is not statically known,
    // so over-approximate to ALL clauses — wiring only the first (tryHandler)
    // orphaned `catch` clauses 2..N, dropping their control/data flow entirely
    // (the binding `catch(T2 e)` and the handler body became unreachable). Mirrors
    // the Swift multi-catch handling.
    if (catchClauses.length > 0) {
      for (let b = protectedStart; b < this.builder.blockCount; b++) {
        for (const handler of handlerEntries) this.builder.edge(b, handler, 'throw');
      }
    }

    const exits: number[] = [];
    if (bodyRes) exits.push(...bodyRes.exits);
    exits.push(...handlerExits);
    // No catch clause at all — an exception re-propagates to the outer handler.
    if (catchClauses.length === 0 && bodyRes) {
      // (A bare `try {}` with no catch is ill-formed C++, but stay robust.)
      this.builder.connect(bodyRes.exits, this.currentHandler(), 'throw');
    }

    const entry = bodyRes?.entry ?? handlerEntries[0];
    if (entry === undefined) return null;
    return { entry, exits: [...new Set(exits)] };
  }
}

/** Build the CFG for one C/C++ function node, or `undefined` if not modelable. */
function buildFunctionCfg(
  fnNode: SyntaxNode,
  filePath: string,
  functionTypes: ReadonlySet<string>,
  controlFlowTypes: ReadonlySet<string>,
  WalkClass: typeof CCfgWalk,
): FunctionCfg | undefined {
  try {
    if (!functionTypes.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    // The body is a compound_statement (field `body`, or first such child).
    const body =
      fnNode.childForFieldName('body') ??
      fnNode.namedChildren.find((c) => c.type === 'compound_statement');
    if (!body || body.type !== 'compound_statement') return undefined; // declaration / no body

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new CCppHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    const walk = new WalkClass(builder, harvest, controlFlowTypes);
    const res = walk.visitSeq(body.namedChildren.filter((c) => c.type !== 'comment'));
    walk.finishGotos();
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
    console.warn(`[cfg] C/C++ buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** The C CFG visitor. */
export function createCCfgVisitor(): CfgVisitor<SyntaxNode> {
  return {
    isFunction: (node) => C_FUNCTION_TYPES.has(node.type),
    buildFunctionCfg: (fnNode, filePath) =>
      buildFunctionCfg(fnNode, filePath, C_FUNCTION_TYPES, C_CONTROL_FLOW_TYPES, CCfgWalk),
  };
}

/** The C++ CFG visitor (C core + exceptions + range-for + lambdas). */
export function createCppCfgVisitor(): CfgVisitor<SyntaxNode> {
  return {
    isFunction: (node) => CPP_FUNCTION_TYPES.has(node.type),
    buildFunctionCfg: (fnNode, filePath) =>
      buildFunctionCfg(fnNode, filePath, CPP_FUNCTION_TYPES, CPP_CONTROL_FLOW_TYPES, CppCfgWalk),
  };
}

export { C_FUNCTION_TYPES, CPP_FUNCTION_TYPES };
