/**
 * Java CfgVisitor (#2195 U4, plan KTD2).
 *
 * Walks a Java method/constructor/lambda's tree-sitter AST and drives the
 * language-agnostic {@link CfgBuilder} to produce a serializable
 * {@link FunctionCfg}, plus a def/use harvest ({@link JavaHarvester}) for the
 * reaching-defs / CDG solvers. Structured like the C# visitor — a
 * `visit_<node_type>` dispatch over the statement taxonomy, driving a
 * per-function {@link ControlFlowContext} — because Java shares C#'s `finally`
 * semantics (try/finally, try-with-resources auto-close = finally, labeled
 * break/continue), which the finalizer-frame + labeled-frame machinery in
 * `control-flow-context.ts` models.
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-java via the introspection probe before use (mandatory pre-step,
 * KTD5). Known Java surprises pre-empted (verified by a real parse):
 *  - Generics are `generic_type` (NOT `parameterized_type`, which this grammar
 *    does not have).
 *  - BOTH the classic colon `switch` and the arrow `switch` parse under
 *    `switch_expression` (there is no `switch_statement` node). Its body is a
 *    `switch_block` (field `body`). A classic group is a
 *    `switch_block_statement_group` (`switch_label` + statements, FALLS THROUGH);
 *    an arrow rule is a `switch_rule` (`switch_label` `->` one body, does NOT
 *    fall through). Case tests live in a `switch_label`.
 *  - Comments are `line_comment` / `block_comment` (NOT `comment`).
 *  - An `if`/`while`/`do`/`synchronized` condition is wrapped in a
 *    `parenthesized_expression`; `consequence`/`alternative`/`body` are
 *    statements directly (no `else_clause` wrapper — an `else if` is the nested
 *    `if_statement` in the `alternative` field).
 *  - `for_statement` uses the `init` field (NOT `initializer`), plus `condition`,
 *    `update`, `body`. `enhanced_for_statement` uses `type`/`name`/`value`/`body`.
 *  - `try_with_resources_statement` carries a `resources` field
 *    (`resource_specification` of `resource` nodes); a plain `try_statement` has
 *    `body` + `catch_clause`s + an optional `finally_clause`.
 *  - `labeled_statement` = a leading `identifier` (the label) then the labeled
 *    statement (no field). `break`/`continue` carry an optional trailing
 *    `identifier` label.
 *
 * Function nodes: `method_declaration`, `constructor_declaration`,
 * `compact_constructor_declaration` (a record's canonical-constructor body), and
 * `lambda_expression`.
 *
 * Edge-kind contract (matches the TS / C# visitors — RD/CDG consume these):
 *  - if/else → `cond-true` / `cond-false`
 *  - loops (for / enhanced-for / while / do-while) → `cond-true` / `loop-back` /
 *    `cond-false`
 *  - switch → `switch-case` / `fallthrough`; a `switch_block_statement_group`
 *    (classic colon form) falls through to the next group when it does not
 *    `break`/`return`/`yield`; a `switch_rule` (arrow form) does NOT fall
 *    through (its single body always rejoins after the switch).
 *  - try/catch → `throw` (every protected-region block → the handler); a
 *    `try_with_resources_statement`'s auto-close runs on BOTH normal and
 *    exception exit (finally semantics), so a `return`/`break`/`continue`
 *    crossing it gets a `finally-*` completion edge too. `synchronized`'s
 *    monitor-release is likewise a deterministic finalizer.
 *  - return / throw / break / continue → the matching terminator kind; a labeled
 *    `break outer;` / `continue outer;` targets the labeled frame, not the
 *    nearest one.
 *  - straight-line → `seq`
 *
 * Classic hazards, handled explicitly (mirrors the C# / TS visitors):
 *  - loops allocate a dedicated loop-exit block so `break` has a target before
 *    the loop's successor is known; `continue` targets the header/increment.
 *  - `for (;;) {}` / `while (true) {}` still emit the structural `header →
 *    loopExit` `cond-false` escape edge so EXIT stays reverse-reachable from
 *    every block — the post-dominator / CDG pass silently emits zero CDG for the
 *    function otherwise.
 *  - labeled `break outer;` / `continue outer;`: the label resolves against the
 *    frame of the construct it names (a labeled loop/switch, or a labeled block),
 *    NOT the nearest enclosing frame. An UNLABELED break never targets a labeled
 *    block frame (control-flow-context.ts enforces this).
 *  - try/catch: conservative exceptional flow — EVERY block in the protected
 *    region edges to the handler (an exception may fire mid-block), matching the
 *    TS `visitTry` over-approximation.
 *
 * Known limitations:
 *  - A value-position `switch` with ≥2 arms is modeled as control flow in the two
 *    highest-value carriers (#2207): a single-declarator `var x = switch (…) {…}`
 *    (arms rejoin at a binding continuation) and `return switch (…) {…}` (each arm
 *    returns). A value-position `switch` in any OTHER position — an assignment RHS
 *    (`x = switch …`), a call argument, or a multi-declarator decl — is still left
 *    INLINE inside its owning block (the value flows to one coalesced block).
 *  - `yield` (in a switch expression) continues to the next statement (it yields
 *    one value to the enclosing switch and the arm ends); the switch-expression
 *    state machine is not modeled, consistent with the inline-value-switch gap.
 *  - Exceptions thrown by a method call mid-statement are over-approximated by
 *    the conservative per-block throw edge inside a `try`; outside any `try` they
 *    are not modeled (no edge), matching TS.
 *  - Def/use harvest scope: see `java-harvest.ts` — field/array writes are not
 *    scalar defs; nested-function (lambda) bodies are opaque in both directions.
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
import type { CfgVisitor, FunctionCfg, StatementFacts } from '../types.js';
import { JavaHarvester } from './java-harvest.js';

/** Java node types that own a CFG-bearing function body. */
const JAVA_FUNCTION_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'lambda_expression',
]);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'enhanced_for_statement',
  'switch_expression',
  'try_statement',
  'try_with_resources_statement',
  'synchronized_statement',
  'return_statement',
  'break_statement',
  'continue_statement',
  'throw_statement',
  'labeled_statement',
  'yield_statement',
  'block',
]);

/** Comment node types tree-sitter-java surfaces (NOT `comment`). */
const COMMENT_TYPES = new Set(['line_comment', 'block_comment']);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

const isComment = (n: SyntaxNode): boolean => COMMENT_TYPES.has(n.type);

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/** A pre-built {@link StatementFacts} record, or undefined when none. */
type StatementFactsLike = StatementFacts | undefined;

/**
 * Per-function Java walk state. One instance per function so the
 * {@link ControlFlowContext}, exception-handler stack, and labeled-block frame
 * bookkeeping are scoped to that function and never leak across functions.
 */
class JavaCfgWalk {
  private readonly cfc = new ControlFlowContext();
  /** Stack of exception-handler entry blocks (catch/finally) a `throw` jumps to. */
  private readonly handlers: number[] = [];
  /** Label(s) pending attachment to the NEXT pushed loop/switch frame. */
  private pendingLabels: string[] = [];

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: JavaHarvester,
  ) {}

  /** Statements of a block node, ignoring comments. */
  private statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter((c) => !isComment(c));
  }

  /** The `body` block of a node (field, or the first `block` child). */
  private bodyBlockOf(node: SyntaxNode): SyntaxNode | undefined {
    return node.childForFieldName('body') ?? node.namedChildren.find((c) => c.type === 'block');
  }

  /** Strip a `parenthesized_expression` wrapper (Java `if`/`while` conditions). */
  private unwrapParen(node: SyntaxNode): SyntaxNode {
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChildren.find((c) => !isComment(c));
      if (inner) return inner;
    }
    return node;
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
   * Whether a statement breaks the current straight-line block. A
   * `switch_expression` breaks only when it is a STATEMENT switch (a value-
   * position switch used directly inside a `block` coalesces). A
   * `local_variable_declaration` whose value is a modelable value-position switch
   * (`var x = switch (…) {…}`, #2207) also breaks — `visitStmt` then models the
   * arms as control flow instead of collapsing the decl to one inline block.
   */
  private breaksBlock(stmt: SyntaxNode): boolean {
    if (stmt.type === 'local_variable_declaration') {
      const v = this.directValue(stmt);
      return v !== undefined && this.isModelableValueBranch(v);
    }
    if (!CONTROL_FLOW_TYPES.has(stmt.type)) return false;
    if (stmt.type === 'switch_expression') return this.isStatementSwitch(stmt);
    return true;
  }

  /** Dispatch one statement to its handler. Non-null except for empty blocks. */
  visitStmt(stmt: SyntaxNode): SeqResult {
    switch (stmt.type) {
      case 'local_variable_declaration': {
        // `var x = switch (k) { … }` (#2207): the value is a value-position
        // branch — model it as control flow and bind the result on the rejoin,
        // instead of collapsing the whole decl to one block.
        const value = this.directValue(stmt);
        if (value && this.isModelableValueBranch(value)) return this.visitBindBranch(stmt, value);
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
      case 'enhanced_for_statement':
        return this.visitForEach(stmt);
      case 'switch_expression':
        return this.visitSwitch(stmt);
      case 'try_statement':
      case 'try_with_resources_statement':
        return this.visitTry(stmt);
      case 'synchronized_statement':
        return this.visitSynchronized(stmt);
      case 'return_statement':
        return this.visitReturn(stmt);
      case 'throw_statement':
        return this.visitThrow(stmt);
      case 'break_statement':
        return this.visitBreak(stmt);
      case 'continue_statement':
        return this.visitContinue(stmt);
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
    // `return switch (k) { … };` (#2207): the returned value is a value-position
    // branch — model it as control flow, with each arm returning (its value IS
    // the function result), threading every active finalizer per arm.
    const branch = stmt.namedChildren.find((c) => !isComment(c));
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
    // A return crosses EVERY active finalizer (finally / try-with-resources /
    // synchronized) before EXIT.
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

  /**
   * `yield e;` (switch-expression arm value) — produces the switch-expression's
   * value and EXITS the enclosing switch (it does NOT fall through to the next
   * colon group). Modeled as a terminator that jumps to the switch exit, threading
   * any finalizer it crosses — exactly like a `break` out of the switch but
   * carrying the yielded value's def/use facts. (Reusing the statement `visitSwitch`
   * for a value-position colon switch would otherwise wire a spurious `fallthrough`
   * edge between yield-terminated arms — #2211 review.)
   */
  private visitYield(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    const res = this.cfc.resolveYield();
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'break');
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

  /** The trailing label `identifier` of a `break`/`continue`, if any. */
  private jumpLabel(stmt: SyntaxNode): string | undefined {
    const id = stmt.namedChildren.find((c) => c.type === 'identifier');
    return id?.text;
  }

  /**
   * `label: <statement>` — the label names the construct it directly wraps. For a
   * loop/switch we forward the label so its pushed frame carries it (`break
   * outer;` then resolves to it); for any other labeled statement we push a
   * labeled-block frame around its body so `break label;` reaches the join after.
   */
  private visitLabeled(stmt: SyntaxNode): SeqResult {
    const labelNode = stmt.namedChildren.find((c) => c.type === 'identifier');
    const label = labelNode?.text;
    const body = stmt.namedChildren.find((c) => c.id !== labelNode?.id && !isComment(c)) ?? null;
    if (!body || label === undefined) return this.visitBody(body);

    if (this.isLoopOrSwitchStatement(body)) {
      // Forward the label to the loop/switch frame this statement pushes.
      this.pendingLabels = [...this.pendingLabels, label];
      return this.visitStmt(body);
    }

    // Labeled non-loop (`blk: { … break blk; … }`) — a break-to-label join after
    // the body; an unlabeled break never matches it.
    const joinBlock = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');
    this.cfc.pushLabeledBlock(joinBlock, [label]);
    const res = this.visitBody(body);
    this.cfc.pop();
    if (res) this.builder.connect(res.exits, joinBlock, 'seq');
    const entry = res?.entry ?? joinBlock;
    return { entry, exits: [joinBlock] };
  }

  private isLoopOrSwitchStatement(node: SyntaxNode): boolean {
    return (
      node.type === 'for_statement' ||
      node.type === 'enhanced_for_statement' ||
      node.type === 'while_statement' ||
      node.type === 'do_statement' ||
      (node.type === 'switch_expression' && this.isStatementSwitch(node))
    );
  }

  /** Take and clear the labels queued by an enclosing `labeled_statement`. */
  private takeLabels(): string[] {
    const labels = this.pendingLabels;
    this.pendingLabels = [];
    return labels;
  }

  private visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = this.condOf(stmt) ?? stmt;
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

    // No `else_clause` wrapper in Java: `alternative` is the else body or the
    // nested `if_statement` of an `else if` chain directly.
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

  /** The (paren-unwrapped) condition expression of an if/while/do/synchronized. */
  private condOf(stmt: SyntaxNode): SyntaxNode | undefined {
    const cond = stmt.childForFieldName('condition');
    return cond ? this.unwrapParen(cond) : undefined;
  }

  private visitWhile(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const cond = this.condOf(stmt) ?? stmt;
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
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
    const labels = this.takeLabels();
    const cond = this.condOf(stmt) ?? stmt;
    const condBlock = this.builder.newBlock(
      startLineOf(cond),
      endLineOf(cond),
      cond.text,
      'normal',
      this.harvest.facts(cond),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(condBlock, loopExit, labels);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    const backTarget = body ? body.entry : condBlock;
    if (body) this.builder.connect(body.exits, condBlock, 'seq');
    this.builder.edge(condBlock, backTarget, 'loop-back'); // cond true → run body again
    this.builder.edge(condBlock, loopExit, 'cond-false');
    return { entry: backTarget, exits: [loopExit] };
  }

  private visitFor(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const init = stmt.childForFieldName('init');
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
    const labels = this.takeLabels();
    // Header text is SYNTHESIZED, so facts come from the name/value nodes
    // directly (the loop variable is a def, the iterated expression a use).
    const header = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      this.forEachHeaderText(stmt),
      'normal',
      this.harvest.forEachHeadFacts(stmt),
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

  private forEachHeaderText(stmt: SyntaxNode): string {
    const name = stmt.childForFieldName('name')?.text ?? '';
    const value = stmt.childForFieldName('value')?.text ?? '';
    return name || value ? `for(${name} : ${value})` : 'for(… : …)';
  }

  /**
   * `synchronized (obj) body` — the monitor release runs on BOTH normal AND
   * exception exit (deterministic finalizer), exactly like a `finally`. Modeled
   * as a synthesized finalizer block so a `return`/`break`/`continue` crossing it
   * threads through and gets a `finally-*` completion edge.
   */
  private visitSynchronized(stmt: SyntaxNode): SeqResult {
    const bodyNode = this.bodyBlockOf(stmt) ?? null;
    const lockExpr = this.synchronizedLock(stmt);
    const releaseFacts = lockExpr ? this.harvest.facts(lockExpr) : undefined;
    return this.buildProtectedSynthetic(bodyNode, stmt, 'release', releaseFacts);
  }

  /** The locked expression of a `synchronized (expr) {…}` (paren-unwrapped). */
  private synchronizedLock(stmt: SyntaxNode): SyntaxNode | undefined {
    const body = stmt.childForFieldName('body');
    const expr = stmt.namedChildren.find((c) => c.id !== body?.id && !isComment(c));
    return expr ? this.unwrapParen(expr) : undefined;
  }

  /** Whether a `switch_expression` is used as a STATEMENT (vs an expression value). */
  private isStatementSwitch(node: SyntaxNode): boolean {
    const p = node.parent;
    if (!p) return false;
    // A statement-position switch is a direct child of a `block`, a classic
    // group, or an arrow rule body; an expression-value switch is nested under a
    // declaration / return / assignment / argument and is NOT one of these.
    return (
      p.type === 'block' ||
      p.type === 'switch_block_statement_group' ||
      p.type === 'switch_rule' ||
      p.type === 'labeled_statement'
    );
  }

  private visitSwitch(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const value = this.condOf(stmt) ?? stmt;
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(value),
      value.text,
      'normal',
      this.harvest.facts(value),
    );
    const switchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushSwitch(switchExit, labels);
    const body = stmt.childForFieldName('body');
    // A `switch_block` holds `switch_block_statement_group`s (classic, fall
    // through) OR `switch_rule`s (arrow, no fallthrough); never both.
    const groups = body
      ? body.namedChildren.filter(
          (c) => c.type === 'switch_block_statement_group' || c.type === 'switch_rule',
        )
      : [];

    // Each group's case-test expression(s) evaluate before the body runs —
    // harvest their uses (and any pattern binding as a may-def) onto the dispatch
    // block, one record per test, CONDITIONALLY (a later case test only runs when
    // earlier cases didn't match).
    for (const g of groups) {
      for (const test of this.caseTests(g)) {
        this.builder.attachFacts(dispatch, this.harvest.factsConditional(test));
      }
    }

    const groupResults = groups.map((g) => this.visitSeq(this.caseStatements(g)));
    const hasDefault = groups.some((g) => this.caseIsDefault(g));
    const arrowForm = groups.some((g) => g.type === 'switch_rule');

    const entryOf: number[] = new Array(groups.length);
    let after = switchExit;
    for (let i = groups.length - 1; i >= 0; i--) {
      entryOf[i] = groupResults[i]?.entry ?? after;
      after = entryOf[i];
    }

    for (let i = 0; i < groups.length; i++) {
      this.builder.edge(dispatch, entryOf[i], 'switch-case');
    }
    if (!hasDefault) this.builder.edge(dispatch, switchExit, 'switch-case'); // no-match path

    // Classic colon groups FALL THROUGH to the next group when not break/return-
    // terminated; arrow rules NEVER fall through (each body rejoins after).
    for (let i = 0; i < groups.length; i++) {
      const res = groupResults[i];
      if (!res) continue;
      if (groups[i].type === 'switch_rule') {
        this.builder.connect(res.exits, switchExit, 'seq');
      } else {
        const fallTarget = i + 1 < groups.length ? entryOf[i + 1] : switchExit;
        this.builder.connect(res.exits, fallTarget, 'fallthrough');
      }
    }
    void arrowForm;

    this.cfc.pop();
    return { entry: dispatch, exits: [switchExit] };
  }

  /** A switch group/rule's body statements (everything but its `switch_label`). */
  private caseStatements(group: SyntaxNode): SyntaxNode[] {
    return group.namedChildren.filter((c) => c.type !== 'switch_label' && !isComment(c));
  }

  /** The case-test value expressions of a group (a `switch_label`'s values). */
  private caseTests(group: SyntaxNode): SyntaxNode[] {
    const label = group.namedChildren.find((c) => c.type === 'switch_label');
    if (!label) return [];
    return label.namedChildren.filter((c) => !isComment(c));
  }

  /** A `default:` group has a `switch_label` with no value children. */
  private caseIsDefault(group: SyntaxNode): boolean {
    const label = group.namedChildren.find((c) => c.type === 'switch_label');
    if (!label) return false;
    return label.namedChildren.filter((c) => !isComment(c)).length === 0;
  }

  // ── value-position branches (#2207) ─────────────────────────────────────────

  /**
   * The direct value of a `local_variable_declaration` with a SINGLE declarator:
   * its `variable_declarator`'s `value` field (`var x = <value>`). Returns
   * undefined for a multi-declarator decl (`int a = …, b = …;`) — modeling those
   * arm-by-arm is out of scope, so they coalesce inline. The DIRECT value only:
   * `var x = f(switch …)` yields the call, not the nested switch, so an
   * argument-position switch stays inline.
   */
  private directValue(stmt: SyntaxNode): SyntaxNode | undefined {
    const declarators = stmt.namedChildren.filter((c) => c.type === 'variable_declarator');
    if (declarators.length !== 1) return undefined;
    return declarators[0].childForFieldName('value') ?? undefined;
  }

  /**
   * Whether `node` is a value-position branch worth modeling as control flow
   * (#2207): a `switch_expression` with ≥2 case groups (a real dispatch). Java has
   * no value-position `if` (the ternary `?:` is deliberately excluded, like elvis
   * in Kotlin), so `switch` is the only carrier.
   */
  private isModelableValueBranch(node: SyntaxNode): boolean {
    if (node.type !== 'switch_expression') return false;
    const body = node.childForFieldName('body');
    if (!body) return false;
    const groups = body.namedChildren.filter(
      (c) => c.type === 'switch_block_statement_group' || c.type === 'switch_rule',
    );
    return groups.length >= 2;
  }

  /**
   * Model a value-position `switch` as control flow regardless of position —
   * {@link visitSeq}'s `isStatementSwitch` gate keeps value-position switches
   * inline, so call {@link visitSwitch} directly here.
   */
  private visitBranchExpr(node: SyntaxNode): TraversalResult {
    return this.visitSwitch(node);
  }

  /**
   * `var x = switch (k) { … }` (#2207): visit the switch as control flow, then
   * rejoin its arms at a facts-only continuation carrying ONLY the bound name's
   * def (the subject + arm-value uses are already harvested onto the switch's
   * blocks). The arms are now control-dependent on the dispatch, and `x` is
   * defined at the join — mirrors the Kotlin / Rust value-position binding.
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

  /**
   * try / catch / finally / try-with-resources. The `resources` of a
   * try-with-resources auto-close on BOTH normal and exception exit — exactly
   * `finally`-shaped — so we synthesize a close finalizer that wraps an explicit
   * `finally` (if any).
   */
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

    // try-with-resources: the resource close is a deterministic finalizer that
    // runs after the body and (if present) before the explicit finally. Model it
    // as a synthesized close block prepended to the finalizer chain.
    const resources = this.tryResources(stmt);
    return this.buildProtected(
      bodyNode ?? null,
      catchClauses,
      finallyBody ?? null,
      resources,
      stmt,
    );
  }

  /** The `resource` nodes of a try-with-resources, or [] for a plain try. */
  private tryResources(stmt: SyntaxNode): SyntaxNode[] {
    const spec = stmt.childForFieldName('resources');
    if (!spec) return [];
    return spec.namedChildren.filter((c) => c.type === 'resource');
  }

  /**
   * Shared try/catch/finally builder. `catchClauses` may be empty; `finallyBody`
   * is the explicit finally's `block` (or null); `resources` are try-with-
   * resources resources (auto-close = an implicit finally that runs first).
   *
   * Models the TS/C# `visitTry` semantics: normal completion of try AND catch
   * flow through the finalizers; a throw in the protected region routes to the
   * handler; early exits crossing a finalizer thread through it (`finally-*`
   * completion edges). The resource close finalizer (synthesized) and the
   * explicit finally are chained so a crossing jump threads BOTH.
   */
  private buildProtected(
    bodyNode: SyntaxNode | null,
    catchClauses: SyntaxNode[],
    finallyBody: SyntaxNode | null,
    resources: SyntaxNode[],
    span: SyntaxNode,
  ): SeqResult {
    // Innermost finalizer first on the active stack = outermost lexically. The
    // resource close runs BEFORE the explicit finally, so push the explicit
    // finally first (deeper) then the close (shallower / nearer the jump).
    const explicitFinRes = finallyBody ? this.visitSeq(this.statementsOf(finallyBody)) : null;
    const explicitFrame = explicitFinRes ? this.cfc.pushFinalizer(explicitFinRes.entry) : null;

    // Synthesized resource-close finalizer (a single block; close()/AutoCloseable
    // has no AST node), carrying the resource bindings' facts as uses.
    let closeRes: TraversalResult | null = null;
    let closeFrame: ReturnType<ControlFlowContext['pushFinalizer']> | null = null;
    if (resources.length > 0) {
      const closeFacts = this.harvest.resourceCloseFacts(resources);
      const closeBlock = this.builder.newBlock(
        endLineOf(span),
        endLineOf(span),
        'close',
        'normal',
        closeFacts,
      );
      closeRes = { entry: closeBlock, exits: [closeBlock] };
      // The close's normal exit flows into the explicit finally (if any).
      if (explicitFinRes) this.builder.edge(closeBlock, explicitFinRes.entry, 'seq');
      closeFrame = this.cfc.pushFinalizer(closeRes.entry);
    }

    // The entry of the finalizer chain (what normal/exception completion runs
    // first): close (if any) else explicit finally.
    const finalizerEntry = closeRes?.entry ?? explicitFinRes?.entry;
    // The set of normal exits AFTER the whole finalizer chain runs.
    const finalizerExits = explicitFinRes?.exits ?? closeRes?.exits ?? null;

    // Build each catch handler.
    const catchEntries: number[] = [];
    const catchExits: number[] = [];
    let firstCatchEntry: number | undefined;
    for (const clause of catchClauses) {
      const clauseBody = clause.childForFieldName('body');
      if (finalizerEntry !== undefined) this.handlers.push(finalizerEntry);
      let res: SeqResult = clauseBody ? this.visitSeq(this.statementsOf(clauseBody)) : null;
      if (finalizerEntry !== undefined) this.handlers.pop();
      if (res === null) {
        // Empty `catch {}` still catches — synthesize one block so exception flow
        // lands somewhere and the post-try code stays reachable.
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

    // Handler for the try body: first catch if present, else the finalizer
    // chain, else the outer handler.
    const tryHandler = firstCatchEntry ?? finalizerEntry ?? this.currentHandler();
    const protectedStart = this.builder.blockCount;
    this.handlers.push(tryHandler);
    const bodyRes = bodyNode
      ? bodyNode.type === 'block'
        ? this.visitSeq(this.statementsOf(bodyNode))
        : this.visitStmt(bodyNode)
      : null;
    this.handlers.pop();

    if (catchClauses.length > 0 || finalizerEntry !== undefined) {
      for (let b = protectedStart; b < this.builder.blockCount; b++) {
        this.builder.edge(b, tryHandler, 'throw');
      }
    }

    // Pop the finalizer frames (inner→outer) and drain their pending legs.
    if (closeFrame && closeRes) {
      this.cfc.pop();
      drainFinalizerPending(this.builder, closeFrame, closeRes.exits);
    }
    if (explicitFrame && explicitFinRes) {
      this.cfc.pop();
      drainFinalizerPending(this.builder, explicitFrame, explicitFinRes.exits);
    }

    const exits: number[] = [];
    if (finalizerEntry !== undefined) {
      if (bodyRes) this.builder.connect(bodyRes.exits, finalizerEntry, 'seq');
      for (const e of catchExits) this.builder.edge(e, finalizerEntry, 'seq');
      if (finalizerExits) exits.push(...finalizerExits);
      // No catch → an exception re-propagates out after the finalizers run.
      if (catchClauses.length === 0 && finalizerExits) {
        this.builder.connect(finalizerExits, this.currentHandler(), 'throw');
      }
    } else {
      if (bodyRes) exits.push(...bodyRes.exits);
      exits.push(...catchExits);
    }

    const entry = bodyRes?.entry ?? finalizerEntry ?? catchEntries[0];
    if (entry === undefined) {
      void span;
      return null;
    }
    return { entry, exits: [...new Set(exits)] };
  }

  /**
   * `synchronized`: a protected body whose finalizer is a SYNTHESIZED single
   * block (Monitor exit has no AST node). The finalizer runs on both normal and
   * exception exit, and crossing jumps thread through it.
   */
  private buildProtectedSynthetic(
    bodyNode: SyntaxNode | null,
    span: SyntaxNode,
    text: string,
    finalizerFacts: StatementFactsLike,
  ): SeqResult {
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
    // The finalizer IS the handler — an exception in the body still runs the
    // release, which then re-propagates to the outer handler.
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
}

/** Build the CFG for one Java function node, or `undefined` if not modelable. */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  try {
    if (!JAVA_FUNCTION_TYPES.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    // The body is a `block` (field `body`) OR an expression (single-expression
    // lambda `x -> expr`).
    const body =
      fnNode.childForFieldName('body') ?? fnNode.namedChildren.find((c) => c.type === 'block');
    if (!body) return undefined; // abstract / interface method — no body

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new JavaHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    if (body.type !== 'block') {
      // Single-expression lambda (`x -> expr`): one block whose value is returned.
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

    const walk = new JavaCfgWalk(builder, harvest);
    const res = walk.visitSeq(body.namedChildren.filter((c) => !isComment(c)));
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
    console.warn(`[cfg] Java buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** Whether a node is a Java function this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return JAVA_FUNCTION_TYPES.has(node.type);
}

/** The Java CFG visitor. */
export function createJavaCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { JAVA_FUNCTION_TYPES };
