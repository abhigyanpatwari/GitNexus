/**
 * Rust CfgVisitor (#2195 U7) — the EXPRESSION-ORIENTED CFG target. Unlike the
 * C-family / Go / Python visitors (statement languages), Rust control flow is
 * built from EXPRESSIONS: `if` / `loop` / `while` / `for` / `match` / `block`
 * are all expressions that produce a value. The visitor still drives the
 * language-agnostic {@link CfgBuilder} to produce a serializable
 * {@link FunctionCfg} plus a def/use harvest ({@link RustHarvester}) for the
 * reaching-defs / CDG solvers, structured like the sibling visitors — a
 * `visit_<node_type>` dispatch over the control-flow taxonomy driving a
 * per-function {@link ControlFlowContext} for labeled break/continue.
 *
 * Every node type and field literal below was grammar-validated against
 * tree-sitter-rust via the introspection probe before use (mandatory pre-step).
 * Rust shapes pre-empted (verified by a real parse):
 *  - functions: `function_item` (fields `name`/`parameters`/`return_type`/`body`;
 *    a method is a `function_item` inside an `impl_item`'s `declaration_list`)
 *    and `closure_expression` (field `parameters`=`closure_parameters`; `body` is
 *    a `block` OR a bare expression — `|x| x + 1`).
 *  - `if_expression` fields `condition` / `consequence` (a `block`) /
 *    `alternative` (an `else_clause` wrapping a `block` or a nested
 *    `if_expression` of an `else if`). The condition can be a `let_condition`
 *    (`if let PAT = e`) or a `let_chain` (`if let PAT = e && cond`).
 *  - `loop_expression` field `body` — the INFINITE loop (NO `condition` field);
 *    an optional `label` NAMED CHILD (label is NOT a field). The key
 *    non-terminating case.
 *  - `while_expression` fields `condition` (may be a `let_condition` for
 *    `while let`) / `body`; optional `label` named child.
 *  - `for_expression` fields `pattern` / `value` / `body`; optional `label`
 *    named child.
 *  - `match_expression` fields `value` / `body` (a `match_block` of `match_arm`s).
 *    A `match_arm` has field `pattern` (a `match_pattern`, which may carry an `if`
 *    guard with field `condition`) and field `value` (the arm body — an
 *    expression or a `block`). Arms do NOT fall through.
 *  - `break_expression` — optional `label` named child AND an optional value
 *    expression (`break 'a 42`). `continue_expression` — optional `label`.
 *  - `return_expression` — optional value child. `try_expression` (`expr?`) —
 *    the early-return operator.
 *  - a `label` node's bare name is its `identifier` child's text (`'outer`'s name
 *    is `outer`), matching `break 'outer` / `continue 'outer`.
 *
 * Edge-kind contract (matches the existing visitors — RD/CDG consume these):
 *  - if / else (incl. `if let`) → `cond-true` / `cond-false`
 *  - `loop {}` (no condition) → `loop-back` (body re-enters) PLUS a structural
 *    `cond-false` escape edge (header → loopExit) so EXIT stays reverse-reachable
 *  - `while` / `while let` / `for` → `cond-true` / `loop-back` / `cond-false`
 *  - `match` dispatch → `switch-case` (NO fallthrough — like Go / Python)
 *  - `break` / `continue` / `return` → the matching terminator kind; a labeled
 *    `break 'outer` / `continue 'outer` targets the labeled loop frame; a
 *    `break value` is still a `break` edge
 *  - the `?` operator (`try_expression`) → `throw` — an early error-return edge to
 *    EXIT from the `?` site (a conservative throw-like edge; the Err/None path)
 *  - straight-line → `seq`
 *
 * Rust-specific modeling decisions (documented approximations):
 *  - `loop {}` is the canonical Rust infinite loop with NO condition. We ALWAYS
 *    emit a structural `header → loopExit` escape edge (exactly as the C-family /
 *    Go visitors do for `while(true)` / `for {}`), so EXIT stays reverse-reachable
 *    and the post-dominator / CDG pass is not silently skipped for the function.
 *    This is the single highest-risk correctness property. A `loop {}` that
 *    DOES `break` also reaches EXIT via the break; the structural escape edge is
 *    emitted either way.
 *  - the `?` operator desugars to a `match` that returns the Err/None early. We
 *    model it conservatively as a `throw` edge to the function EXIT from the block
 *    that contains the `?` — so the post-`?` continuation stays reachable (the Ok
 *    path) AND the early-exit path is represented. Multiple `?` in one block emit
 *    one early-exit edge per `?`-bearing block (deduped by the builder).
 *  - a closure (`closure_expression`) is collected as its OWN function by
 *    `isFunction`, so its body gets a standalone CFG; in the ENCLOSING function it
 *    is an opaque straight-line value (its body is not followed inline), exactly
 *    as the Go visitor treats a spawned closure and the TS visitor an arrow body.
 *  - the trailing tail expression of a `block` (no `;`) is the block's value; for
 *    control-flow purposes it just falls off normally to the block's successor.
 *
 * Known limitations:
 *  - panic: a `panic!()` (or an out-of-bounds index, an `unwrap` on `None`) aborts
 *    the function abnormally, but tree-sitter sees only a normal macro/method call.
 *    The panic-unwind path is NOT modeled (documented gap, not faked) — Rust has
 *    no try/catch, so there is no handler structure to route to.
 *  - async (`async fn`, `.await`): the suspension points are modeled as normal
 *    straight-line control flow (no scheduler edges).
 *  - block scope + shadowing in the def/use harvest is flattened to one function
 *    table (see rust-harvest.ts) — a documented v1 over-approximation.
 *  - macro bodies (`println!`, `vec!`, custom macros) are opaque token trees — any
 *    control flow expanded by a macro is invisible.
 *
 * Returns `undefined` (never throws) for an AST shape it cannot model, so a
 * malformed function never drops the whole file's CFG group (R4).
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import { ControlFlowContext, wireJumpThroughFinalizers } from '../control-flow-context.js';
import type { TraversalResult } from '../traversal-result.js';
import type { CfgVisitor, FunctionCfg } from '../types.js';
import { RustHarvester } from './rust-harvest.js';

/** Rust node types that own a CFG-bearing function body. */
const RUST_FUNCTION_TYPES = new Set(['function_item', 'closure_expression']);

/**
 * Expression / statement node types that break a basic block (everything else
 * coalesces). `expression_statement` is the `<expr>;` wrapper; the control-flow
 * EXPRESSIONS inside it are unwrapped by {@link visitStmt}.
 */
const CONTROL_FLOW_TYPES = new Set([
  'expression_statement',
  'if_expression',
  'loop_expression',
  'while_expression',
  'for_expression',
  'match_expression',
  'return_expression',
  'break_expression',
  'continue_expression',
  'block',
]);

/** Expression node types that the statement walker treats as control-flow. */
const CONTROL_FLOW_EXPR_TYPES = new Set([
  'if_expression',
  'loop_expression',
  'while_expression',
  'for_expression',
  'match_expression',
  'return_expression',
  'break_expression',
  'continue_expression',
  'block',
]);

/** Node types whose subtrees are opaque (a nested function owns its own CFG). */
const NESTED_FUNCTION_TYPES = new Set(['function_item', 'closure_expression']);

/** Rust comment node types — line (`//`) and block (slash-star) comments. */
const COMMENT_TYPES = new Set(['line_comment', 'block_comment']);
const isNotComment = (n: SyntaxNode): boolean => !COMMENT_TYPES.has(n.type);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/**
 * Per-function Rust walk state. One instance per function so the
 * {@link ControlFlowContext} and label tables are scoped to that function and
 * never leak across functions.
 */
class RustCfgWalk {
  private readonly cfc = new ControlFlowContext();

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: RustHarvester,
  ) {}

  /** Statements of a `block`, ignoring comments. */
  private statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter(isNotComment);
  }

  /** The `body` of a node (a `block`, or a bare expression for a closure / arm). */
  private bodyOf(node: SyntaxNode): SyntaxNode | undefined {
    return node.childForFieldName('body') ?? undefined;
  }

  /** Visit a body that may be a `block` or a single expression. */
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
        if (this.isControlFlow(stmt)) {
          openSimple = undefined; // close any open straight-line block
          const res = this.visitStmt(stmt);
          if (res === null) continue; // transparent (empty nested block)
          if (entry === undefined) entry = res.entry;
          else this.builder.connect(dangling, res.entry, 'seq');
          dangling = [...res.exits];
        } else {
          const idx =
            openSimple === undefined ? this.openBlock(stmt) : this.extendOpen(openSimple, stmt);
          if (openSimple === undefined) {
            if (entry === undefined) entry = idx;
            else this.builder.connect(dangling, idx, 'seq');
            dangling = [idx];
          }
          openSimple = idx;
          // A straight-line statement that contains a `?` early-returns to EXIT.
          this.wireTryExits(stmt, idx);
        }
      }

      if (entry === undefined) return null;
      return { entry, exits: dangling };
    });
  }

  private openBlock(stmt: SyntaxNode): number {
    return this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
  }

  private extendOpen(open: number, stmt: SyntaxNode): number {
    this.builder.extendBlock(open, endLineOf(stmt), stmt.text, this.harvest.facts(stmt));
    return open;
  }

  /** Whether a statement node breaks the current straight-line block. */
  private isControlFlow(stmt: SyntaxNode): boolean {
    if (stmt.type === 'expression_statement') {
      const inner = this.exprStmtInner(stmt);
      return inner ? CONTROL_FLOW_EXPR_TYPES.has(inner.type) : false;
    }
    if (stmt.type === 'let_declaration') {
      // `let v = loop {…}` / `let w = if c {…} else {…}` / `let PAT = e else {…}`
      // — the value is a control-flow EXPRESSION, or the let-else alternative
      // block is divergent; either way the let must be modeled structurally.
      const value = stmt.childForFieldName('value');
      const alt = stmt.childForFieldName('alternative');
      return (value !== null && CONTROL_FLOW_EXPR_TYPES.has(value.type)) || alt !== null;
    }
    return CONTROL_FLOW_TYPES.has(stmt.type);
  }

  /** The inner expression of an `expression_statement` (`if x {…};`). */
  private exprStmtInner(stmt: SyntaxNode): SyntaxNode | undefined {
    return stmt.namedChildren.find(isNotComment);
  }

  /** Dispatch one statement to its handler. Non-null except for empty blocks. */
  visitStmt(stmt: SyntaxNode): SeqResult {
    // Unwrap an `expression_statement` to its control-flow expression.
    if (stmt.type === 'expression_statement') {
      const inner = this.exprStmtInner(stmt);
      if (inner && CONTROL_FLOW_EXPR_TYPES.has(inner.type)) return this.visitStmt(inner);
      return this.visitSimple(stmt);
    }
    if (stmt.type === 'let_declaration') return this.visitLet(stmt);
    switch (stmt.type) {
      case 'if_expression':
        return this.visitIf(stmt);
      case 'loop_expression':
        return this.visitLoop(stmt);
      case 'while_expression':
        return this.visitWhile(stmt);
      case 'for_expression':
        return this.visitFor(stmt);
      case 'match_expression':
        return this.visitMatch(stmt);
      case 'return_expression':
        return this.visitReturn(stmt);
      case 'break_expression':
        return this.visitBreak(stmt);
      case 'continue_expression':
        return this.visitContinue(stmt);
      case 'block':
        return this.visitSeq(this.statementsOf(stmt));
      default:
        return this.visitSimple(stmt);
    }
  }

  private visitSimple(stmt: SyntaxNode): TraversalResult {
    const idx = this.openBlock(stmt);
    this.wireTryExits(stmt, idx);
    return { entry: idx, exits: [idx] };
  }

  /**
   * `let PAT = VALUE [else { ALT }]` whose VALUE is a control-flow expression
   * (`let v = loop {…}`, `let w = if c {…} else {…}`, `let m = match …`) or which
   * has a divergent let-else ALT block. A plain `let x = e;` never reaches here
   * (it coalesces into a straight-line block in {@link visitSeq}).
   *
   * The value's control-flow construct is visited as a sub-CFG; the let-pattern's
   * bindings are defs that happen on the value's NORMAL completion — attached to a
   * facts-only continuation block the value's exits feed. For a `let … else`, the
   * ALT block runs on the refutable-failure path and (per Rust's rules) MUST
   * diverge (return/break/continue/panic); it is visited as control flow, so its
   * own jumps wire directly to their targets and it contributes no normal exit.
   */
  private visitLet(stmt: SyntaxNode): TraversalResult {
    const value = stmt.childForFieldName('value');
    const alt = stmt.childForFieldName('alternative');
    const cfValue = value !== null && CONTROL_FLOW_EXPR_TYPES.has(value.type);

    let entry: number;
    let normalExits: number[];
    if (cfValue && value) {
      // `let v = loop {…}` — the value is a control-flow construct: visit it, then
      // attach ONLY the pattern's binding defs to a facts-only continuation (the
      // value's uses are already harvested onto its own blocks).
      const valueRes = this.visitStmt(value);
      const cont = this.builder.newBlock(
        startLineOf(stmt),
        startLineOf(stmt),
        '',
        'normal',
        this.harvest.letPatternFacts(stmt),
      );
      this.builder.connect(valueRes?.exits ?? [], cont, 'seq');
      entry = valueRes ? valueRes.entry : cont;
      normalExits = [cont];
    } else {
      // A simple-value `let PAT = e [else {…}]` — ONE block with the whole let's
      // facts (value uses + pattern defs). It reaches here only via the let-else
      // alternative (a plain `let x = e;` coalesces in visitSeq).
      const idx = this.openBlock(stmt);
      this.wireTryExits(stmt, idx);
      entry = idx;
      normalExits = [idx];
    }

    // `let … else { … }` — the else block runs on the binding-FAILURE path and
    // (per Rust) MUST diverge (return/break/continue/panic); visit it as control
    // flow so its jumps wire themselves to their targets. It is NOT on the normal
    // continuation — branched from the binding site with a `cond-false` (refute)
    // edge.
    if (alt) {
      const altRes = this.visitBody(alt);
      if (altRes) this.builder.connect(normalExits, altRes.entry, 'cond-false');
    }

    return { entry, exits: normalExits };
  }

  /**
   * Emit a `throw` (early-return) edge to EXIT for every `?` operator inside a
   * straight-line statement's subtree (excluding nested function bodies). The
   * `?` desugars to "return Err(...) early"; modeling it as a throw-like edge to
   * EXIT keeps the early-exit path represented while the Ok path falls through
   * normally. Deduped by the builder, so repeated `?` in a block emit one edge.
   */
  private wireTryExits(stmt: SyntaxNode, fromBlock: number): void {
    if (this.containsTry(stmt)) this.builder.edge(fromBlock, this.builder.exitIndex, 'throw');
  }

  private containsTry(node: SyntaxNode): boolean {
    if (node.type === 'try_expression') return true;
    if (NESTED_FUNCTION_TYPES.has(node.type)) return false; // opaque
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && this.containsTry(c)) return true;
    }
    return false;
  }

  /** `return [expr]` — direct edge to the function EXIT. */
  private visitReturn(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    // A `return f()?;` early-returns on the `?` path too.
    this.wireTryExits(stmt, idx);
    this.builder.edge(idx, this.builder.exitIndex, 'return');
    return { entry: idx, exits: [] };
  }

  /**
   * `break ['label] [value]` — targets the labeled loop frame if labeled, else the
   * nearest enclosing loop. `break value` is still a `break` edge (the value is a
   * normal use harvested onto the block).
   */
  private visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    this.wireTryExits(stmt, idx);
    const label = this.jumpLabel(stmt);
    const res = this.cfc.resolveBreak(label);
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'break');
    return { entry: idx, exits: [] };
  }

  /** `continue ['label]` — re-tests the labeled (or nearest) loop header. */
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

  /** The bare name (`outer`) of a `break`/`continue`'s `'label`, if any. */
  private jumpLabel(stmt: SyntaxNode): string | undefined {
    const label = stmt.namedChildren.find((c) => c.type === 'label');
    return this.labelName(label);
  }

  /** The bare identifier name of a `label` node (`'outer` ⇒ `outer`). */
  private labelName(label: SyntaxNode | undefined): string | undefined {
    if (!label) return undefined;
    const id = label.namedChildren.find((c) => c.type === 'identifier');
    return id?.text ?? label.text.replace(/^'/, '');
  }

  /**
   * The optional `'label` of a loop expression (a NAMED CHILD, not a field — Rust
   * attaches the label directly to the loop, unlike Go's `labeled_statement`).
   */
  private loopLabels(stmt: SyntaxNode): string[] {
    const label = stmt.namedChildren.find((c) => c.type === 'label');
    const name = this.labelName(label);
    return name !== undefined ? [name] : [];
  }

  /**
   * `if COND { … } [else { … } | else if …]`. The condition can be a plain
   * expression, a `let_condition` (`if let PAT = e`), or a `let_chain`. The header
   * carries the condition's def/use facts (an `if let` pattern is a def, its value
   * a use). The else `alternative` is an `else_clause` wrapping a `block` or a
   * nested `if_expression` (the `else if` chain).
   */
  private visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.condFacts(cond, false),
    );
    this.wireTryExits(cond, header);

    const exits: number[] = [];
    const thenRes = this.visitBody(stmt.childForFieldName('consequence'));
    if (thenRes) {
      this.builder.edge(header, thenRes.entry, 'cond-true');
      exits.push(...thenRes.exits);
    } else {
      exits.push(header); // empty then — true path falls through
    }

    const elseNode = this.elseBodyOf(stmt);
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

  /** The else body of an `if_expression` (unwraps the `else_clause` wrapper). */
  private elseBodyOf(stmt: SyntaxNode): SyntaxNode | undefined {
    const alt = stmt.childForFieldName('alternative');
    if (!alt) return undefined;
    if (alt.type === 'else_clause') {
      // The clause wraps a `block` or a nested `if_expression` (`else if`).
      return alt.namedChildren.find(isNotComment);
    }
    return alt;
  }

  /**
   * `loop { … }` — Rust's INFINITE loop (NO condition). Body exits re-enter the
   * header (`loop-back`); a `break` reaches `loopExit`. We ALWAYS emit a
   * structural `header → loopExit` `cond-false` escape edge so EXIT stays
   * reverse-reachable (a `loop {}` with no break never reaches EXIT otherwise, and
   * the CDG pass would be silently skipped for the whole function).
   */
  private visitLoop(stmt: SyntaxNode): TraversalResult {
    const labels = this.loopLabels(stmt);
    const header = this.builder.newBlock(startLineOf(stmt), startLineOf(stmt), 'loop');
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
    const body = this.visitBody(this.bodyOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty `loop {}` re-enters
    }
    // Structural escape edge — keeps EXIT reverse-reachable even for `loop {}`
    // with no `break` (the canonical Rust non-terminating case).
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  /**
   * `while COND { … }` (and `while let PAT = e { … }`). Standard loop: header
   * tests, true → body → loop-back, false → loop exit. The `while let` pattern is
   * a may-def on the header (the binding does not happen on the exit iteration).
   */
  private visitWhile(stmt: SyntaxNode): TraversalResult {
    const labels = this.loopLabels(stmt);
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(cond),
      cond.text,
      'normal',
      this.condFacts(cond, true),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
    const body = this.visitBody(this.bodyOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-tests
    }
    // Structural exit edge — even `while true {}` keeps EXIT reverse-reachable.
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  /**
   * `for PAT in ITER { … }`. The header binds the loop pattern (a def) and uses
   * the iterated expression. Standard loop topology.
   */
  private visitFor(stmt: SyntaxNode): TraversalResult {
    const labels = this.loopLabels(stmt);
    const value = stmt.childForFieldName('value');
    const headEnd = value ? endLineOf(value) : startLineOf(stmt);
    const header = this.builder.newBlock(
      startLineOf(stmt),
      headEnd,
      this.forHeaderText(stmt),
      'normal',
      this.harvest.forHeadFacts(stmt),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
    const body = this.visitBody(this.bodyOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-iterates
    }
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private forHeaderText(stmt: SyntaxNode): string {
    const pat = stmt.childForFieldName('pattern')?.text ?? '';
    const value = stmt.childForFieldName('value')?.text ?? '';
    return pat || value ? `for ${pat} in ${value}` : 'for';
  }

  /**
   * `match VALUE { PAT [if guard] => ARM, … }`. Arms do NOT fall through (like
   * Go / Python). Each arm body is dispatched from the subject block with a
   * `switch-case` edge; arm bodies rejoin AFTER the match. A `match` with no
   * irrefutable `_` arm also reaches the join directly (no-match path), keeping
   * EXIT reverse-reachable.
   */
  private visitMatch(stmt: SyntaxNode): TraversalResult {
    const value = stmt.childForFieldName('value');
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      value ? endLineOf(value) : startLineOf(stmt),
      value ? `match ${value.text}` : 'match',
      'normal',
      value ? this.harvest.facts(value) : undefined,
    );
    if (value) this.wireTryExits(value, dispatch);
    const matchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    const body =
      stmt.childForFieldName('body') ?? stmt.namedChildren.find((c) => c.type === 'match_block');
    const arms = body ? body.namedChildren.filter((c) => c.type === 'match_arm') : [];

    // Each arm's pattern bindings (`Some(n) =>`) are MAY-defs from the matched
    // subject, and a guarded arm (`PAT if g`) evaluates `g` conditionally — both
    // are harvested onto the dispatch block (co-located with the subject's use, so
    // a tainted subject reaches the binding), as may-defs (a later arm binds/tests
    // only when earlier ones didn't match). #2206.
    for (const arm of arms) {
      const patFacts = this.harvest.matchArmPatternFacts(arm);
      if (patFacts) this.builder.attachFacts(dispatch, patFacts);
      const guard = this.armGuard(arm);
      if (guard) this.builder.attachFacts(dispatch, this.harvest.factsConditional(guard));
    }

    this.cfc.pushSwitch(matchExit, []);
    let hasIrrefutable = false;
    for (const arm of arms) {
      // The arm body may be an expr or block; its pattern bindings were harvested
      // onto the dispatch above (#2206).
      const armBody = this.visitBody(arm.childForFieldName('value'));
      const entry = armBody?.entry ?? matchExit;
      this.builder.edge(dispatch, entry, 'switch-case');
      if (armBody) this.builder.connect(armBody.exits, matchExit, 'seq');
      if (this.isIrrefutableArm(arm)) hasIrrefutable = true;
    }
    this.cfc.pop();

    // No catch-all arm → a no-match path reaches the exit directly. (A real Rust
    // match is exhaustive, but a non-`_`-tailed match keeps EXIT reverse-reachable
    // even when every arm body jumps.)
    if (!hasIrrefutable) this.builder.edge(dispatch, matchExit, 'switch-case');

    return { entry: dispatch, exits: [matchExit] };
  }

  /** The guard condition of a `match_arm` (`PAT if g`), if any. */
  private armGuard(arm: SyntaxNode): SyntaxNode | undefined {
    const pat = arm.childForFieldName('pattern');
    return pat?.childForFieldName('condition') ?? undefined;
  }

  /** A `_ =>` arm with no guard is the unconditional catch-all. */
  private isIrrefutableArm(arm: SyntaxNode): boolean {
    if (this.armGuard(arm)) return false;
    const pat = arm.childForFieldName('pattern');
    return pat?.text.trim() === '_';
  }

  /**
   * Def/use facts for an `if`/`while` condition. A `let_condition` binds a pattern
   * (a def — a may-def for `while let`, which re-tests) and uses its value; a
   * `let_chain` threads through each `let_condition`. A plain expression is walked
   * for uses.
   */
  private condFacts(cond: SyntaxNode, loopCond: boolean): ReturnType<RustHarvester['facts']> {
    if (cond.type === 'let_condition') {
      return this.harvest.letConditionFacts(cond, loopCond);
    }
    // A `let_chain` (`let PAT = e && cond`) — harvest the whole chain. The let
    // bindings inside it are defs (may-defs for a while-let chain).
    return this.harvest.facts(cond);
  }
}

/** Build the CFG for one Rust function / closure node, or `undefined`. */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  try {
    if (!RUST_FUNCTION_TYPES.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    const body = fnNode.childForFieldName('body');
    if (!body) return undefined; // trait method signature / no body

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new RustHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    const walk = new RustCfgWalk(builder, harvest);

    if (body.type !== 'block') {
      // A closure with an expression body (`|x| x + 1`): one block whose value is
      // the returned expression. A `?` inside it early-returns to EXIT.
      const res = walk.visitStmt(body);
      builder.edge(builder.entryIndex, res ? res.entry : builder.exitIndex, 'seq');
      builder.connect(res ? res.exits : [builder.entryIndex], builder.exitIndex, 'seq');
      return builder.finish(harvest.bindingTable());
    }

    const res = walk.visitSeq(body.namedChildren.filter(isNotComment));
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
    console.warn(`[cfg] Rust buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** Whether a node is a Rust function/closure this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return RUST_FUNCTION_TYPES.has(node.type);
}

/** The Rust CFG visitor. */
export function createRustCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { RUST_FUNCTION_TYPES };
