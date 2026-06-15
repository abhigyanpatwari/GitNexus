/**
 * C# CfgVisitor (#2195 U3, plan KTD2).
 *
 * Walks a C# function's tree-sitter AST and drives the language-agnostic
 * {@link CfgBuilder} to produce a serializable {@link FunctionCfg}, plus a
 * def/use harvest ({@link CsharpHarvester}) for the reaching-defs / CDG solvers.
 * Structured like the TS visitor — a `visit_<node_type>` dispatch over the
 * statement taxonomy, driving a per-function {@link ControlFlowContext} — because
 * C# shares TS's `finally` semantics (try/finally AND `using`/`lock`-as-finally),
 * which the finalizer-frame machinery in `control-flow-context.ts` models.
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-c-sharp via the introspection probe before use (mandatory pre-step,
 * KTD5). Known C# surprises pre-empted: records are `record_declaration` (NOT
 * `record_struct_declaration`); there is no `else_clause` wrapper (an
 * `if_statement`'s `alternative` is the else body / nested `if` directly); switch
 * cases live in `switch_section`s under a `switch_body`; `variable_declarator`
 * exposes only a `name` field (the initializer is a positional child);
 * `finally_clause` / `lock_statement` / `catch_filter_clause` expose no field for
 * their body/condition (positional children).
 *
 * Function nodes: `method_declaration`, `local_function_statement`,
 * `constructor_declaration`, `lambda_expression`, `anonymous_method_expression`,
 * and expression-bodied members (`body` is an `arrow_expression_clause`).
 *
 * Edge-kind contract (matches the TS visitor — RD/CDG consume these):
 *  - if/else → `cond-true` / `cond-false`
 *  - loops (for / foreach / while / do-while) → `cond-true` / `loop-back` /
 *    `cond-false`
 *  - switch (`switch_statement`) → `switch-case` / `fallthrough`; a
 *    `switch_expression` arm dispatches as `switch-case` (each arm a guarded
 *    branch, no fallthrough)
 *  - try/catch → `throw` (every protected-region block → the handler); a jump
 *    crossing a `finally` → `finally-return` / `finally-break` / `finally-continue`
 *  - `using` / `lock` → modeled like try/finally: the dispose (`using`) runs on
 *    BOTH normal and exception exit (deterministic), so a `return`/`break`/
 *    `continue` crossing it gets the `finally-*` completion edge too. `lock`'s
 *    monitor-release is likewise a deterministic finalizer.
 *  - return / throw / break / continue → the matching terminator kind
 *  - straight-line → `seq`
 *
 * Classic hazards, handled explicitly (mirrors the TS visitor):
 *  - loops allocate a dedicated loop-exit block so `break` has a target before
 *    the loop's successor is known; `continue` targets the header/increment.
 *  - `for (;;) {}` / `while (true) {}` still emit the structural `header →
 *    loopExit` `cond-false` escape edge so EXIT stays reverse-reachable from
 *    every block — the post-dominator / CDG pass silently emits zero CDG for the
 *    function otherwise.
 *  - labeled `goto`: labels resolve within the function (forward AND backward);
 *    an unresolved `goto` (incl. `goto case`/`goto default`, which target a
 *    switch arm this CFG does not label) routes to EXIT and logs, preserving
 *    single-exit.
 *  - try/catch: conservative exceptional flow — EVERY block in the protected
 *    region edges to the handler (an exception may fire mid-block), matching the
 *    TS `visitTry` over-approximation.
 *
 * Known limitations:
 *  - `yield return` / `yield break`: C# iterator methods compile to a hidden
 *    state machine; tree-sitter shows only the surface `yield_statement`. This
 *    visitor models `yield break` as a terminator → EXIT (`return`) and
 *    `yield return e` as a block whose value continues to the next statement
 *    (the producer resumes after the consumer pulls). The real suspend/resume
 *    state-machine control flow is NOT modeled — documented gap, not faked.
 *  - `goto case L;` / `goto default;` have no statically-labeled CFG target
 *    (switch arms are not labeled blocks here) and route to EXIT like an
 *    unresolved label.
 *  - Async/await suspension points are modeled as straight-line (the awaited
 *    continuation is not a separate flow), consistent with the TS visitor.
 *  - A value-position `switch_expression` (`k switch {…}`) with ≥2 arms IS modeled
 *    as a `switch-case` dispatch in three carriers (#2207): a single-declarator
 *    `var x = k switch {…}` (arms rejoin at a binding continuation), `return k
 *    switch {…}`, and an `=> k switch {…}` expression body (each arm returns).
 *    A value switch in any OTHER position — an assignment RHS (`x = k switch …`),
 *    a call argument, or a multi-declarator decl — stays INLINE (one block).
 *  - Def/use harvest scope: see `csharp-harvest.ts` — member/element writes are
 *    not scalar defs; nested-function bodies are opaque in both directions.
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
import { CsharpHarvester } from './csharp-harvest.js';

/** C# node types that own a CFG-bearing function body. */
const CSHARP_FUNCTION_TYPES = new Set([
  'method_declaration',
  'local_function_statement',
  'constructor_declaration',
  'lambda_expression',
  'anonymous_method_expression',
]);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'foreach_statement',
  'switch_statement',
  'try_statement',
  'using_statement',
  'lock_statement',
  'return_statement',
  'break_statement',
  'continue_statement',
  'throw_statement',
  'goto_statement',
  'labeled_statement',
  'yield_statement',
  'block',
]);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/**
 * Per-function C# walk state. One instance per function so the
 * {@link ControlFlowContext}, exception-handler stack, and label tables are
 * scoped to that function and never leak across functions.
 */
class CsharpCfgWalk {
  private readonly cfc = new ControlFlowContext();
  /** Stack of exception-handler entry blocks (catch/finally) a `throw` jumps to. */
  private readonly handlers: number[] = [];
  /** label name → its `labeled_statement` body's entry block (resolved on demand). */
  private readonly labelBlocks = new Map<string, number>();
  /** Pending gotos to a label not yet seen: label → list of source blocks. */
  private readonly pendingGotos = new Map<string, number[]>();

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: CsharpHarvester,
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

      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i];
        if (this.isUsingLocalDecl(stmt)) {
          // `using var f = e;` (C# 8 declaration form): the dispose runs at the END
          // of the enclosing scope, so the REST of this sequence is the protected
          // body. The acquisition (`var f = e`) is a normal block OUTSIDE the dispose
          // region (if it throws, the resource was never acquired) (#2206).
          openSimple = undefined;
          const acq = this.builder.newBlock(
            startLineOf(stmt),
            endLineOf(stmt),
            stmt.text,
            'normal',
            this.harvest.facts(stmt),
          );
          if (entry === undefined) entry = acq;
          else this.builder.connect(dangling, acq, 'seq');
          const scope = this.buildUsingDeclScope(stmt, stmts.slice(i + 1));
          this.builder.connect([acq], scope.entry, 'seq');
          dangling = [...scope.exits];
          break; // the rest of the sequence is consumed by the dispose scope
        }
        if (this.breaksBlock(stmt)) {
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

  /**
   * Whether a statement breaks the current straight-line block. Adds the
   * value-position switch carrier to the base {@link CONTROL_FLOW_TYPES} set: a
   * `local_declaration_statement` whose single initializer is a modelable
   * `switch_expression` (`var x = k switch {…}`, #2207) breaks so `visitStmt`
   * models the arms as control flow instead of collapsing the decl to one block.
   */
  private breaksBlock(stmt: SyntaxNode): boolean {
    if (this.isValueSwitchDecl(stmt)) return true;
    return CONTROL_FLOW_TYPES.has(stmt.type);
  }

  /** Dispatch one statement to its handler. Non-null except for empty blocks. */
  visitStmt(stmt: SyntaxNode): SeqResult {
    switch (stmt.type) {
      case 'local_declaration_statement': {
        // `var x = k switch { … }` (#2207): the initializer is a value-position
        // branch — model it as control flow and bind the result on the rejoin.
        const branch = this.declValueSwitch(stmt);
        if (branch) return this.visitBindBranch(stmt, branch);
        return this.visitSimple(stmt);
      }
      case 'if_statement':
        return this.visitIf(stmt);
      case 'while_statement':
        return this.visitWhile(stmt);
      case 'do_statement':
        return this.visitDoWhile(stmt);
      case 'for_statement':
        return this.visitFor(stmt);
      case 'foreach_statement':
        return this.visitForEach(stmt);
      case 'switch_statement':
        return this.visitSwitch(stmt);
      case 'try_statement':
        return this.visitTry(stmt);
      case 'using_statement':
        return this.visitUsing(stmt);
      case 'lock_statement':
        return this.visitLock(stmt);
      case 'return_statement':
        return this.visitReturn(stmt);
      case 'throw_statement':
        return this.visitThrow(stmt);
      case 'break_statement':
        return this.visitBreak(stmt);
      case 'continue_statement':
        return this.visitContinue(stmt);
      case 'goto_statement':
        return this.visitGoto(stmt);
      case 'labeled_statement':
        return this.visitLabeled(stmt);
      case 'yield_statement':
        return this.visitYield(stmt);
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

  private visitReturn(stmt: SyntaxNode): TraversalResult {
    // `return k switch { … };` (#2207): the returned value is a value-position
    // branch — model it as control flow, with each arm returning (its value IS
    // the function result), threading every active finalizer per arm.
    const branch = stmt.namedChildren.find((c) => c.type !== 'comment');
    if (branch && this.isModelableValueBranch(branch)) {
      const res = this.visitBranchExpr(branch);
      const finalizers = this.cfc.finalizersForReturn();
      for (const ex of res.exits) {
        wireJumpThroughFinalizers(this.builder, ex, finalizers, this.builder.exitIndex, 'return');
      }
      return { entry: res.entry, exits: [] };
    }
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    // A return crosses EVERY active finally (try/using/lock) before EXIT.
    wireJumpThroughFinalizers(
      this.builder,
      idx,
      this.cfc.finalizersForReturn(),
      this.builder.exitIndex,
      'return',
    );
    return { entry: idx, exits: [] };
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

  /** `yield return e;` continues; `yield break;` terminates the iterator. */
  private visitYield(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    // `yield break;` (no value child) ends iteration → EXIT (modeled like return);
    // `yield return e;` (has a value child) yields one element and CONTINUES, so
    // it falls through to the next statement. The hidden iterator state machine
    // is not modeled (documented limitation).
    if (this.isYieldBreak(stmt)) {
      wireJumpThroughFinalizers(
        this.builder,
        idx,
        this.cfc.finalizersForReturn(),
        this.builder.exitIndex,
        'return',
      );
      return { entry: idx, exits: [] };
    }
    return { entry: idx, exits: [idx] };
  }

  /** A `yield break;` has no value child; `yield return e;` has one. */
  private isYieldBreak(stmt: SyntaxNode): boolean {
    return stmt.namedChildCount === 0;
  }

  private visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const res = this.cfc.resolveBreak(undefined);
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'break');
    return { entry: idx, exits: [] };
  }

  private visitContinue(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const res = this.cfc.resolveContinue(undefined);
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'continue');
    return { entry: idx, exits: [] };
  }

  /** `goto label;` — route to the label block if known, else defer / EXIT. */
  private visitGoto(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const label = this.gotoLabel(stmt);
    if (label === undefined) {
      // `goto case L;` / `goto default;` — no statically-labeled CFG target.
      this.builder.edge(idx, this.builder.exitIndex, 'seq');
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

  private visitLabeled(stmt: SyntaxNode): SeqResult {
    // `labeled_statement` = label `identifier` + the labeled statement.
    const labelNode = stmt.namedChildren.find((c) => c.type === 'identifier');
    const label = labelNode?.text;
    const body = stmt.namedChildren.find((c) => c.id !== labelNode?.id && c.type !== 'comment');
    const res = this.visitBody(body ?? null);
    if (label !== undefined) {
      const entry = res?.entry ?? this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');
      this.labelBlocks.set(label, entry);
      const pending = this.pendingGotos.get(label);
      if (pending) {
        for (const from of pending) this.builder.edge(from, entry, 'seq');
        this.pendingGotos.delete(label);
      }
      if (!res) return { entry, exits: [entry] };
    }
    return res;
  }

  private visitIf(stmt: SyntaxNode): TraversalResult {
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

    // No `else_clause` wrapper in C#: `alternative` is the else body or the
    // nested `if_statement` for an `else if` chain directly.
    const elseNode = stmt.childForFieldName('alternative');
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

    this.cfc.pushLoop(header, loopExit);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-tests
    }
    // Always emit the structural exit edge — even `while (true)` keeps EXIT
    // reverse-reachable for the post-dominator / CDG pass.
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private visitDoWhile(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const condBlock = this.builder.newBlock(
      startLineOf(cond),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(condBlock, loopExit);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    const backTarget = body ? body.entry : condBlock;
    if (body) this.builder.connect(body.exits, condBlock, 'seq');
    this.builder.edge(condBlock, backTarget, 'loop-back'); // cond true → run body again
    this.builder.edge(condBlock, loopExit, 'cond-false');
    return { entry: backTarget, exits: [loopExit] };
  }

  private visitFor(stmt: SyntaxNode): TraversalResult {
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

    this.cfc.pushLoop(incrBlock, loopExit);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

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

  private visitForEach(stmt: SyntaxNode): TraversalResult {
    // Header text is SYNTHESIZED, so facts come from the left/right nodes
    // directly (the loop variable is a def, the iterated expression a use).
    const header = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      this.forEachHeaderText(stmt),
      'normal',
      this.harvest.forEachHeadFacts(stmt),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit);
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

  private forEachHeaderText(stmt: SyntaxNode): string {
    const left = stmt.childForFieldName('left')?.text ?? '';
    const right = stmt.childForFieldName('right')?.text ?? '';
    return left || right ? `foreach(${left} in ${right})` : 'foreach(… in …)';
  }

  private visitSwitch(stmt: SyntaxNode): TraversalResult {
    const value = stmt.childForFieldName('value') ?? stmt;
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(value),
      value.text,
      'normal',
      this.harvest.facts(value),
    );
    const switchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushSwitch(switchExit);
    const body = stmt.childForFieldName('body');
    const sections = body ? body.namedChildren.filter((c) => c.type === 'switch_section') : [];

    // Each `switch_section`'s case-test patterns/`when` clauses evaluate before
    // the body runs — harvest their uses (and any pattern binding as a may-def)
    // onto the dispatch block, one record per section, conditionally (a later
    // section test only runs when earlier sections didn't match).
    for (const sec of sections) {
      for (const test of this.sectionTests(sec)) {
        this.builder.attachFacts(dispatch, this.harvest.factsConditional(test));
      }
    }

    const sectionResults = sections.map((s) => this.visitSeq(this.sectionStatements(s)));
    const hasDefault = sections.some((s) => this.sectionIsDefault(s));

    const entryOf: number[] = new Array(sections.length);
    let after = switchExit;
    for (let i = sections.length - 1; i >= 0; i--) {
      entryOf[i] = sectionResults[i]?.entry ?? after;
      after = entryOf[i];
    }

    for (let i = 0; i < sections.length; i++) {
      this.builder.edge(dispatch, entryOf[i], 'switch-case');
    }
    if (!hasDefault) this.builder.edge(dispatch, switchExit, 'switch-case'); // no-match path

    // A non-`break` section's dangling exits fall through to the next section
    // (an empty `case 2:` falling into `case 3:`, or `goto case`-less spill).
    for (let i = 0; i < sections.length; i++) {
      const res = sectionResults[i];
      if (!res) continue;
      const fallTarget = i + 1 < sections.length ? entryOf[i + 1] : switchExit;
      this.builder.connect(res.exits, fallTarget, 'fallthrough');
    }

    this.cfc.pop();
    return { entry: dispatch, exits: [switchExit] };
  }

  /** A switch_section's body statements (everything but its case labels/patterns). */
  private sectionStatements(section: SyntaxNode): SyntaxNode[] {
    return section.namedChildren.filter((c) => this.isStatementLike(c) && c.type !== 'comment');
  }

  /** The case-test expressions of a section (constant patterns + when clauses). */
  private sectionTests(section: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (const c of section.namedChildren) {
      if (c.type === 'when_clause') {
        const inner = c.namedChild(0);
        if (inner) out.push(inner);
      } else if (!this.isStatementLike(c) && c.type !== 'comment') {
        out.push(c); // a pattern (constant_pattern / declaration_pattern / …)
      }
    }
    return out;
  }

  /** A `default:` section has only a `default` label (no pattern). */
  private sectionIsDefault(section: SyntaxNode): boolean {
    return !section.namedChildren.some(
      (c) => !this.isStatementLike(c) && c.type !== 'comment' && c.type !== 'when_clause',
    );
  }

  /** Heuristic: a section child is statement-like if it ends a basic-block run. */
  private isStatementLike(node: SyntaxNode): boolean {
    return node.type.endsWith('_statement') || node.type === 'block';
  }

  // ── value-position switch expression (#2207) ────────────────────────────────

  /**
   * The `switch_expression` initializer of a single-declarator
   * `local_declaration_statement` (`var x = k switch {…}`) when it is a modelable
   * value branch, else undefined. A `using` decl and a multi-declarator decl are
   * excluded (the `using` dispose path / multi-declarator stay inline).
   */
  private declValueSwitch(stmt: SyntaxNode): SyntaxNode | undefined {
    if (stmt.type !== 'local_declaration_statement') return undefined;
    if (this.isUsingLocalDecl(stmt)) return undefined;
    const decl = stmt.namedChildren.find((c) => c.type === 'variable_declaration');
    if (!decl) return undefined;
    const declarators = decl.namedChildren.filter((c) => c.type === 'variable_declarator');
    if (declarators.length !== 1) return undefined;
    const init = this.declaratorInit(declarators[0]);
    return init && this.isModelableValueBranch(init) ? init : undefined;
  }

  private isValueSwitchDecl(stmt: SyntaxNode): boolean {
    return this.declValueSwitch(stmt) !== undefined;
  }

  /**
   * The initializer of a `variable_declarator` — its named child after `name`.
   * NOTE: deliberately duplicated in `csharp-harvest.ts` (the harvester is a
   * standalone class with no shared base — repo convention). The two copies must
   * stay in sync; there is no C#-specific shared module to host it, and the only
   * module both files share is the generic `utils/ast-helpers` (types only).
   */
  private declaratorInit(declarator: SyntaxNode): SyntaxNode | undefined {
    const name = declarator.childForFieldName('name');
    for (let i = 0; i < declarator.namedChildCount; i++) {
      const c = declarator.namedChild(i);
      if (c && c.id !== name?.id) return c;
    }
    return undefined;
  }

  /**
   * Whether `node` is a value-position branch worth modeling as control flow
   * (#2207): a `switch_expression` (`k switch {…}`) with ≥2 arms — a real
   * dispatch. C# value-position `if` does not exist (the ternary `?:` is excluded,
   * like elvis in Kotlin).
   */
  private isModelableValueBranch(node: SyntaxNode): boolean {
    if (node.type !== 'switch_expression') return false;
    return node.namedChildren.filter((c) => c.type === 'switch_expression_arm').length >= 2;
  }

  /**
   * Model a value-position `switch_expression` (`k switch { p => v, … }`) as a CFG
   * dispatch: a discriminant block, each arm's value expression a block reached by
   * a `switch-case` edge, all arms rejoining at a single exit. The arm patterns /
   * `when` guards are harvested as conditional uses on the dispatch (a later arm
   * test runs only when earlier arms didn't match), mirroring {@link visitSwitch}.
   */
  private visitSwitchExpr(node: SyntaxNode): TraversalResult {
    const arms = node.namedChildren.filter((c) => c.type === 'switch_expression_arm');
    const discriminant = node.namedChildren.find((c) => c.type !== 'switch_expression_arm') ?? node;
    const dispatch = this.builder.newBlock(
      startLineOf(node),
      endLineOf(discriminant),
      discriminant.text,
      'normal',
      this.harvest.facts(discriminant),
    );
    const switchExit = this.builder.newBlock(endLineOf(node), endLineOf(node), '');

    let hasCatchAll = false;
    for (const arm of arms) {
      const pattern = arm.namedChild(0);
      const guard = arm.namedChildren.find((c) => c.type === 'when_clause');
      if (pattern) this.builder.attachFacts(dispatch, this.harvest.factsConditional(pattern));
      if (guard) {
        const inner = guard.namedChild(0);
        if (inner) this.builder.attachFacts(dispatch, this.harvest.factsConditional(inner));
      }
      // An unguarded `_`/`var` arm matches everything — the exhaustive default.
      if (!guard && pattern && (pattern.type === 'discard' || pattern.type === 'var_pattern')) {
        hasCatchAll = true;
      }
      const value = this.armValue(arm);
      const armBlock = this.builder.newBlock(
        startLineOf(value ?? arm),
        endLineOf(value ?? arm),
        (value ?? arm).text,
        'normal',
        value ? this.harvest.facts(value) : undefined,
      );
      this.builder.edge(dispatch, armBlock, 'switch-case');
      this.builder.edge(armBlock, switchExit, 'seq');
    }
    // A non-exhaustive switch throws at runtime; conservatively keep EXIT directly
    // reachable from the dispatch when no catch-all arm covers the no-match path.
    if (!hasCatchAll) this.builder.edge(dispatch, switchExit, 'switch-case');

    return { entry: dispatch, exits: [switchExit] };
  }

  /** The value expression of a `switch_expression_arm` (the child after `=>`). */
  private armValue(arm: SyntaxNode): SyntaxNode | undefined {
    // pattern [when_clause] => value — the value is the LAST named child.
    return arm.namedChild(arm.namedChildCount - 1) ?? undefined;
  }

  /** Model a value-position branch as control flow (only `switch_expression`). */
  private visitBranchExpr(node: SyntaxNode): TraversalResult {
    return this.visitSwitchExpr(node);
  }

  /**
   * An expression-bodied member's value (`=> k switch {…}`, #2207): if it is a
   * modelable value branch, model its arms as control flow (each arm returns the
   * function result); otherwise return null so the caller falls back to a single
   * inline block.
   */
  tryVisitValueBranchBody(expr: SyntaxNode): TraversalResult | null {
    return this.isModelableValueBranch(expr) ? this.visitBranchExpr(expr) : null;
  }

  /**
   * `var x = k switch { … }` (#2207): visit the switch as control flow, then
   * rejoin its arms at a facts-only continuation carrying ONLY the bound name's
   * def (the discriminant + arm-value uses are already on the switch's blocks).
   * The arms are now control-dependent on the dispatch, and `x` is defined at the
   * join — mirrors the Java / Kotlin / Rust value-position binding.
   */
  private visitBindBranch(stmt: SyntaxNode, branch: SyntaxNode): TraversalResult {
    const res = this.visitBranchExpr(branch);
    const cont = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      '',
      'normal',
      this.harvest.bindingDefFacts(stmt),
    );
    this.builder.connect(res.exits, cont, 'seq');
    return { entry: res.entry, exits: [cont] };
  }

  private visitTry(stmt: SyntaxNode): SeqResult {
    const bodyNode = stmt.childForFieldName('body');
    const catchClauses: SyntaxNode[] = [];
    let finallyClause: SyntaxNode | undefined;
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const c = stmt.namedChild(i);
      if (c?.type === 'catch_clause') catchClauses.push(c);
      else if (c?.type === 'finally_clause') finallyClause = c;
    }
    const finallyBody = finallyClause?.namedChildren.find((c) => c.type === 'block');
    return this.buildProtected(bodyNode ?? null, catchClauses, finallyBody ?? null, stmt);
  }

  /**
   * `using (resource) body` — the dispose runs deterministically on BOTH normal
   * AND exception exit, which is exactly `try { body } finally { dispose }`. We
   * model the dispose as a synthesized finalizer block (the AST has no Dispose()
   * call node), so a `return`/`break`/`continue` crossing it threads through and
   * gets a `finally-*` completion edge.
   */
  private visitUsing(stmt: SyntaxNode): SeqResult {
    const bodyNode = this.bodyBlockOf(stmt) ?? null;
    // The resource (declaration or expression) is the named child before `body`.
    const resource = this.usingResource(stmt);
    const disposeFacts = resource ? this.harvest.facts(resource) : undefined;
    return this.buildProtectedSynthetic(bodyNode, stmt, 'dispose', disposeFacts, resource ?? stmt);
  }

  /**
   * `lock (obj) body` — the monitor release runs on both normal and exception
   * exit (deterministic finalizer), same shape as `using`'s dispose.
   */
  private visitLock(stmt: SyntaxNode): SeqResult {
    const bodyNode = this.bodyBlockOf(stmt) ?? null;
    const lockObj = stmt.namedChildren.find((c) => c.type !== 'block');
    const releaseFacts = lockObj ? this.harvest.facts(lockObj) : undefined;
    return this.buildProtectedSynthetic(bodyNode, stmt, 'release', releaseFacts, lockObj ?? stmt);
  }

  /** The `using` resource node (variable_declaration or an expression). */
  private usingResource(stmt: SyntaxNode): SyntaxNode | undefined {
    const body = stmt.childForFieldName('body');
    return stmt.namedChildren.find((c) => c.id !== body?.id && c.type !== 'comment');
  }

  /**
   * Whether `stmt` is a C# 8 `using var f = …;` declaration (a
   * `local_declaration_statement` with a leading `using` keyword) — the dispose
   * runs at enclosing-scope exit, NOT a delimited block (#2206).
   */
  private isUsingLocalDecl(stmt: SyntaxNode): boolean {
    if (stmt.type !== 'local_declaration_statement') return false;
    for (let i = 0; i < stmt.childCount; i++) {
      if (stmt.child(i)?.type === 'using') return true;
    }
    return false;
  }

  /**
   * Build the dispose scope for a `using var f = …;` declaration: `restStmts` (the
   * rest of the enclosing block) is the protected body, and a synthetic `dispose`
   * finalizer runs on normal exit AND on exception, with a `return`/`break`/
   * `continue` crossing it threading through (finally-* completion edges). Mirrors
   * {@link buildProtectedSynthetic}, but the body is a statement LIST (#2206).
   */
  private buildUsingDeclScope(declStmt: SyntaxNode, restStmts: SyntaxNode[]): SeqResult {
    const disposeBlock = this.builder.newBlock(endLineOf(declStmt), endLineOf(declStmt), 'dispose');
    const finFrame = this.cfc.pushFinalizer(disposeBlock);

    const protectedStart = this.builder.blockCount;
    this.handlers.push(disposeBlock);
    const bodyRes = this.visitSeq(restStmts);
    this.handlers.pop();

    for (let b = protectedStart; b < this.builder.blockCount; b++) {
      this.builder.edge(b, disposeBlock, 'throw');
    }

    this.cfc.pop();
    drainFinalizerPending(this.builder, finFrame, [disposeBlock]);

    if (bodyRes) this.builder.connect(bodyRes.exits, disposeBlock, 'seq');
    this.builder.connect([disposeBlock], this.currentHandler(), 'throw');

    return { entry: bodyRes?.entry ?? disposeBlock, exits: [disposeBlock] };
  }

  /**
   * Shared try/catch/finally builder. `catchClauses` may be empty; `finallyBody`
   * is the finally's `block` (or null). Models the TS `visitTry` semantics:
   * normal completion of try AND catch flow through finally; a throw in the
   * protected region routes to the handler; early exits crossing the finally
   * thread through it (finally-* completion edges).
   */
  private buildProtected(
    bodyNode: SyntaxNode | null,
    catchClauses: SyntaxNode[],
    finallyBody: SyntaxNode | null,
    span: SyntaxNode,
  ): SeqResult {
    const finallyRes = finallyBody ? this.visitSeq(this.statementsOf(finallyBody)) : null;
    const finFrame = finallyRes ? this.cfc.pushFinalizer(finallyRes.entry) : null;

    // Build each catch handler.
    const catchEntries: number[] = [];
    const catchExits: number[] = [];
    let firstCatchEntry: number | undefined;
    for (const clause of catchClauses) {
      const clauseBody = clause.childForFieldName('body');
      if (finallyRes) this.handlers.push(finallyRes.entry);
      let res: SeqResult = clauseBody ? this.visitSeq(this.statementsOf(clauseBody)) : null;
      if (finallyRes) this.handlers.pop();
      if (res === null) {
        // Empty `catch {}` still catches — synthesize one block so exception
        // flow lands somewhere and the post-try code stays reachable.
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
      catchEntries.push(res.entry);
      catchExits.push(...res.exits);
      if (firstCatchEntry === undefined) firstCatchEntry = res.entry;
    }

    // Handler for the try body: first catch if present, else finally, else outer.
    const tryHandler = firstCatchEntry ?? finallyRes?.entry ?? this.currentHandler();
    const protectedStart = this.builder.blockCount;
    this.handlers.push(tryHandler);
    const bodyRes = bodyNode
      ? bodyNode.type === 'block'
        ? this.visitSeq(this.statementsOf(bodyNode))
        : this.visitStmt(bodyNode)
      : null;
    this.handlers.pop();

    if (catchClauses.length > 0 || finallyBody) {
      for (let b = protectedStart; b < this.builder.blockCount; b++) {
        this.builder.edge(b, tryHandler, 'throw');
      }
    }

    if (finFrame && finallyRes) {
      this.cfc.pop();
      drainFinalizerPending(this.builder, finFrame, finallyRes.exits);
    }

    const exits: number[] = [];
    if (finallyRes) {
      if (bodyRes) this.builder.connect(bodyRes.exits, finallyRes.entry, 'seq');
      for (const e of catchExits) this.builder.edge(e, finallyRes.entry, 'seq');
      exits.push(...finallyRes.exits);
      // No catch → an exception re-propagates out after finally runs.
      if (catchClauses.length === 0) {
        this.builder.connect(finallyRes.exits, this.currentHandler(), 'throw');
      }
    } else {
      if (bodyRes) exits.push(...bodyRes.exits);
      exits.push(...catchExits);
    }

    const entry = bodyRes?.entry ?? finallyRes?.entry ?? catchEntries[0];
    if (entry === undefined) {
      void span;
      return null;
    }
    return { entry, exits: [...new Set(exits)] };
  }

  /**
   * `using`/`lock`: a protected body whose finalizer is a SYNTHESIZED single
   * block (Dispose() / Monitor.Exit() have no AST node). The finalizer runs on
   * both normal and exception exit, and crossing jumps thread through it.
   */
  private buildProtectedSynthetic(
    bodyNode: SyntaxNode | null,
    span: SyntaxNode,
    text: string,
    finalizerFacts: StatementFactsLike,
    factsNode: SyntaxNode,
  ): SeqResult {
    void factsNode;
    const finalizerBlock = this.builder.newBlock(
      endLineOf(span),
      endLineOf(span),
      text,
      'normal',
      finalizerFacts ?? undefined,
    );
    const finRes: TraversalResult = { entry: finalizerBlock, exits: [finalizerBlock] };
    const finFrame = this.cfc.pushFinalizer(finRes.entry);

    const protectedStart = this.builder.blockCount;
    // The finalizer IS the handler — an exception in the body still runs dispose,
    // which then re-propagates to the outer handler.
    this.handlers.push(finRes.entry);
    const bodyRes = bodyNode
      ? bodyNode.type === 'block'
        ? this.visitSeq(this.statementsOf(bodyNode))
        : this.visitStmt(bodyNode)
      : null;
    this.handlers.pop();

    for (let b = protectedStart; b < this.builder.blockCount; b++) {
      this.builder.edge(b, finRes.entry, 'throw');
    }

    this.cfc.pop();
    drainFinalizerPending(this.builder, finFrame, finRes.exits);

    // Normal completion of the body flows through the finalizer; the finalizer's
    // exit re-propagates an exception to the outer handler (it had no catch).
    if (bodyRes) this.builder.connect(bodyRes.exits, finRes.entry, 'seq');
    this.builder.connect(finRes.exits, this.currentHandler(), 'throw');

    const entry = bodyRes?.entry ?? finRes.entry;
    return { entry, exits: [...finRes.exits] };
  }

  /** Nearest enclosing exception handler, or the function EXIT. */
  private currentHandler(): number {
    return this.handlers.length ? this.handlers[this.handlers.length - 1] : this.builder.exitIndex;
  }

  /** The target label of a `goto label;` (undefined for `goto case`/`goto default`). */
  private gotoLabel(stmt: SyntaxNode): string | undefined {
    const id = stmt.namedChildren.find((c) => c.type === 'identifier');
    return id?.text;
  }
}

/** A pre-built {@link StatementFacts} record, or undefined when none. */
type StatementFactsLike = ReturnType<CsharpHarvester['facts']> | undefined;

/** Build the CFG for one C# function node, or `undefined` if not modelable. */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  try {
    if (!CSHARP_FUNCTION_TYPES.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    // The body is a `block` (field `body`) OR an `arrow_expression_clause`
    // (expression-bodied member) OR an expression (single-expression lambda).
    const body =
      fnNode.childForFieldName('body') ?? fnNode.namedChildren.find((c) => c.type === 'block');
    if (!body) return undefined; // abstract / partial / interface member — no body

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new CsharpHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    if (body.type === 'arrow_expression_clause' || body.type !== 'block') {
      // Expression-bodied member / single-expression lambda: one block whose
      // value is returned. For an arrow clause the value is its inner expression.
      const expr = body.type === 'arrow_expression_clause' ? (body.namedChild(0) ?? body) : body;
      // `=> k switch { … }` (#2207): model the arms as control flow, each arm
      // returning the function result, instead of one inline block.
      const branchRes = new CsharpCfgWalk(builder, harvest).tryVisitValueBranchBody(expr);
      if (branchRes) {
        builder.edge(builder.entryIndex, branchRes.entry, 'seq');
        builder.connect(branchRes.exits, builder.exitIndex, 'return');
        return builder.finish(harvest.bindingTable());
      }
      const blk = builder.newBlock(
        startLineOf(expr),
        endLineOf(expr),
        expr.text,
        'normal',
        harvest.facts(expr),
      );
      builder.edge(builder.entryIndex, blk, 'seq');
      builder.edge(blk, builder.exitIndex, 'return');
      return builder.finish(harvest.bindingTable());
    }

    const walk = new CsharpCfgWalk(builder, harvest);
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
    console.warn(`[cfg] C# buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** Whether a node is a C# function this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return CSHARP_FUNCTION_TYPES.has(node.type);
}

/** The C# CFG visitor. */
export function createCsharpCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { CSHARP_FUNCTION_TYPES };
