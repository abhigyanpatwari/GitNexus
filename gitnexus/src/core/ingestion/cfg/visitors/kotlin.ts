/**
 * Kotlin CfgVisitor (#2195) — the VENDORED-GRAMMAR JVM/brace-family CFG target.
 *
 * Kotlin's tree-sitter grammar (vendored, NOT an npm package — loaded via
 * `requireVendoredGrammar('tree-sitter-kotlin')`, exactly like tree-sitter-swift)
 * is field-less for control flow: NONE of the control-flow nodes expose
 * `childForFieldName` fields (verified by a real parse — every `fieldNameForChild`
 * came back null), so this visitor navigates purely by child TYPE and position.
 * Every node-type literal below was grammar-validated against the vendored
 * tree-sitter-kotlin via the introspection probe before use (mandatory pre-step —
 * the grammar-literal CI gate maps `kotlin.ts → Kotlin` and fails on a wrong
 * literal).
 *
 * Structured like the Java / C# visitors — a `visit_<node_type>` dispatch over the
 * statement taxonomy driving a per-function {@link ControlFlowContext} — because
 * Kotlin shares JVM `finally` semantics (try/catch/finally + labeled
 * break/continue), which the finalizer-frame + labeled-frame machinery in
 * `control-flow-context.ts` models.
 *
 * Kotlin's defining quirk: `if` / `when` / `try` are EXPRESSIONS. The visitor
 * treats each as a control-flow construct when it appears in STATEMENT position
 * (a direct child of a `statements` list) and as opaque straight-line value when
 * nested inside an expression (e.g. `val y = if (x) 1 else 2`) — exactly the
 * Java statement-vs-value-switch split.
 *
 * Kotlin shapes pre-empted (verified by a real parse):
 *  - functions: `function_declaration` (name `simple_identifier`,
 *    `function_value_parameters`, optional `: user_type`, `function_body`),
 *    `anonymous_function` (`fun (...) function_body`), and `lambda_literal`
 *    (`{ lambda_parameters? -> statements }`). A `function_body` is either
 *    `{ statements }` OR an expression body `= expr` (no `statements` wrapper).
 *  - `if_expression`: `if ( COND ) control_structure_body [ else
 *    (control_structure_body | if_expression) ]`. No `else_clause` wrapper — an
 *    `else if` is the nested `if_expression` after the `else` keyword.
 *  - `when_expression`: `when when_subject? { when_entry* }`. A `when_subject` is
 *    `( expr )` or `( val v = expr )`. A `when_entry` is `when_condition*` (comma
 *    separated, OR an `else` keyword) `-> control_structure_body`. Arms do NOT
 *    fall through. A `when_condition` may wrap a `range_test` (`in 1..10`),
 *    `type_test` (`is T` / `!is T`), or a plain expression.
 *  - `for_statement`: `for ( (variable_declaration | multi_variable_declaration)
 *    in COLLECTION ) control_structure_body`.
 *  - `while_statement`: `while ( COND ) control_structure_body`.
 *  - `do_while_statement` — BOTTOM-TEST: `do control_structure_body while ( COND )`.
 *  - `try_expression`: `try { statements } catch_block* finally_block?`. A
 *    `catch_block` is `catch ( simple_identifier : user_type ) { statements }`;
 *    a `finally_block` is `finally { statements }`.
 *  - `jump_expression` — `return [expr]` / `return@label` / `break` / `break@label`
 *    / `continue` / `continue@label` / `throw expr`. The leading anonymous keyword
 *    child (`return` / `return@` / `break` / `break@` / `continue` / `continue@` /
 *    `throw`) decides; a labeled jump carries a `label` named child.
 *  - `label` — a labeled loop is preceded by a SIBLING `label` (`outer@`) in the
 *    same `statements`, NOT a wrapper; the jump's target label child is `outer`.
 *  - `control_structure_body` wraps either `{ statements }` or a single bare
 *    statement (`if (c) a()`).
 *
 * Edge-kind contract (matches the existing visitors — RD/CDG consume these):
 *  - if / else → `cond-true` / `cond-false`
 *  - `when` dispatch → `switch-case` (NO fallthrough — each arm rejoins after)
 *  - `for` / `while` → `cond-true` / `loop-back` / `cond-false`
 *  - `do … while` → bottom-test: body runs first, condition `loop-back` (true) /
 *    `cond-false` (exit)
 *  - try/catch → `throw` (every protected-region block → the handler); a
 *    `finally` runs on BOTH normal and exception exit, so a `return`/`break`/
 *    `continue` crossing it threads through it (`finally-*` completion edges).
 *  - return(@label) / throw / break(@label) / continue(@label) → the matching
 *    terminator kind; a labeled jump targets the labeled loop frame.
 *  - straight-line → `seq`
 *
 * Classic hazards, handled explicitly (mirrors Java / C# / Swift):
 *  - loops allocate a dedicated loop-exit block so `break` has a target before the
 *    loop's successor is known; `continue` targets the header.
 *  - `while (true) {}` / `do {} while (true)` still emit the structural `header →
 *    loopExit` `cond-false` escape edge so EXIT stays reverse-reachable from every
 *    block — the post-dominator / CDG pass silently emits zero CDG otherwise. This
 *    is the single highest-risk correctness property.
 *  - labeled `break@outer` / `continue@outer`: the label resolves against the
 *    labeled loop frame, NOT the nearest one.
 *  - try/catch: conservative exceptional flow — EVERY block in the protected
 *    region edges to the handler (an exception may fire mid-block), matching the
 *    Java/C#/TS over-approximation.
 *
 * Kotlin-specific modeling decisions (documented approximations):
 *  - a value-position `if` (with `else`) / `when` (≥2 arms) / `try` IS modeled as
 *    control flow (#2205) in four carriers: a `val/var x = <branch>` binding, an
 *    `x = <branch>` assignment, a `return <branch>`, and a `fun f() = <branch>`
 *    expression body — its arms become separate CFG blocks that rejoin at a
 *    binding/return continuation. A branch in any OTHER value position — nested in
 *    a call argument (`f(when …)`), a deeper subexpression — is left INLINE (the
 *    value flows to the consumer in one block). The ternary-like `?:` (elvis) and
 *    `?.` micro-branches are excluded by design.
 *  - a `lambda_literal` / nested `anonymous_function` / nested
 *    `function_declaration` is collected as its OWN function by `isFunction`, so
 *    its body gets a standalone CFG; in the ENCLOSING function it is an opaque
 *    straight-line value (its body is not followed inline). A `return@label`
 *    inside a lambda routes to the lambda's OWN EXIT (the lambda is its own CFG).
 *  - a `throw` with no enclosing `try`/`catch` routes to EXIT (the function
 *    propagates the exception to its caller), matching Java.
 *
 * Known limitations:
 *  - `?.` safe-call and `?:` elvis short-circuit are NOT modeled as branches —
 *    their conditional sub-evaluation is a HARVEST may-def concern (see
 *    kotlin-harvest.ts), not a CFG split (consistent with the TS `&&`/`??`
 *    treatment, which also stays in one block).
 *  - secondary-constructor `constructor(...)` bodies and property getters/setters
 *    are NOT function nodes in this grammar's CFG-bearing set; v1 does not build a
 *    CFG for them (documented gap).
 *  - `inline fun` non-local returns: a `return` inside an inline-lambda argument
 *    can return from the ENCLOSING function in real Kotlin; the lambda is modeled
 *    as its own CFG (the conservative, sound-for-RD direction), so that non-local
 *    return is not threaded into the enclosing function — a documented v1 gap.
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
import { KotlinHarvester } from './kotlin-harvest.js';

/** Kotlin node types that own a CFG-bearing function body. */
const KOTLIN_FUNCTION_TYPES = new Set([
  'function_declaration',
  'anonymous_function',
  'lambda_literal',
]);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if_expression',
  'when_expression',
  'for_statement',
  'while_statement',
  'do_while_statement',
  'try_expression',
  'jump_expression',
  'label',
]);

/** Comment / non-code node types tree-sitter-kotlin surfaces (NOT `comment`). */
const COMMENT_TYPES = new Set(['line_comment', 'multiline_comment', 'shebang_line']);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

const isComment = (n: SyntaxNode): boolean => COMMENT_TYPES.has(n.type);

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/**
 * Per-function Kotlin walk state. One instance per function so the
 * {@link ControlFlowContext}, exception-handler stack, and labeled-frame
 * bookkeeping are scoped to that function and never leak across functions.
 */
class KotlinCfgWalk {
  private readonly cfc = new ControlFlowContext();
  /** Stack of exception-handler entry blocks (catch/finally) a `throw` jumps to. */
  private readonly handlers: number[] = [];
  /** Label(s) pending attachment to the NEXT pushed loop frame. */
  private pendingLabels: string[] = [];

  constructor(
    private readonly builder: CfgBuilder,
    private readonly harvest: KotlinHarvester,
  ) {}

  /** Named statements of a `statements` node, ignoring comments. */
  private statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter((c) => !isComment(c));
  }

  /**
   * Unwrap a `control_structure_body`: a `{ statements }` block yields its
   * `statements` node; a bare single statement (`if (c) a()`) yields itself.
   */
  private bodyOf(csb: SyntaxNode | undefined | null): SyntaxNode | undefined {
    if (!csb) return undefined;
    if (csb.type === 'control_structure_body') {
      const stmts = csb.namedChildren.find((c) => c.type === 'statements');
      if (stmts) return stmts;
      const single = csb.namedChildren.find((c) => !isComment(c));
      return single;
    }
    return csb;
  }

  /** Visit a `control_structure_body` (block or single statement). */
  private visitBody(csb: SyntaxNode | undefined | null): SeqResult {
    return this.builder.withNesting(() => {
      const inner = this.bodyOf(csb);
      if (!inner) return null;
      if (inner.type === 'statements') return this.visitSeq(this.statementsOf(inner));
      return this.visitStmt(inner);
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
          if (res === null) continue; // transparent (empty nested block / label-only)
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
   * Whether a statement breaks the current straight-line block. `if` / `when` /
   * `try` are EXPRESSIONS in Kotlin — they break a block when used as a STATEMENT
   * (a direct child of a `statements` list), OR when they are the value of a
   * `val/var x = <branch>` binding or an `x = <branch>` assignment (#2205) —
   * `visitStmt`'s `property_declaration` / `assignment` case then models the arms
   * as control flow. A call argument value position still coalesces (a remaining
   * gap — the branch is nested in a call, harder to bind).
   */
  private isControlFlow(stmt: SyntaxNode): boolean {
    if (stmt.type === 'label') return true; // queue label, emit no block
    if (stmt.type === 'property_declaration') {
      const v = this.directValue(stmt);
      return v !== undefined && this.isModelableValueBranch(v);
    }
    if (stmt.type === 'assignment') return this.assignmentBranch(stmt) !== undefined;
    if (!CONTROL_FLOW_TYPES.has(stmt.type)) return false;
    if (this.isExpressionConstruct(stmt.type)) return this.isStatementPosition(stmt);
    return true;
  }

  private isExpressionConstruct(type: string): boolean {
    return type === 'if_expression' || type === 'when_expression' || type === 'try_expression';
  }

  /**
   * Whether an expression-construct (`if`/`when`/`try`) is in STATEMENT position
   * (a direct `statements` child, or a `control_structure_body` that is itself a
   * bare statement) vs an expression VALUE (nested under a declaration / jump /
   * assignment / argument). Statement-position constructs are modeled as
   * dispatch/branch; value-position ones stay inline.
   */
  private isStatementPosition(node: SyntaxNode): boolean {
    const p = node.parent;
    if (!p) return false;
    return p.type === 'statements' || p.type === 'control_structure_body';
  }

  /** Dispatch one statement to its handler. Non-null except for empty / label-only. */
  visitStmt(stmt: SyntaxNode): SeqResult {
    if (stmt.type === 'label') {
      // A label preceding its loop — queue it; the loop construct picks it up.
      const name = this.labelName(stmt);
      if (name !== undefined) this.pendingLabels = [...this.pendingLabels, name];
      return null; // emits no block of its own
    }
    switch (stmt.type) {
      case 'if_expression':
        return this.isStatementPosition(stmt) ? this.visitIf(stmt) : this.visitSimple(stmt);
      case 'when_expression':
        return this.isStatementPosition(stmt) ? this.visitWhen(stmt) : this.visitSimple(stmt);
      case 'try_expression':
        return this.isStatementPosition(stmt) ? this.visitTry(stmt) : this.visitSimple(stmt);
      case 'for_statement':
        return this.visitFor(stmt);
      case 'while_statement':
        return this.visitWhile(stmt);
      case 'do_while_statement':
        return this.visitDoWhile(stmt);
      case 'jump_expression':
        return this.visitJump(stmt);
      case 'property_declaration': {
        // `val x = when (k) { … }` / `val x = if (c) a else b` (#2205): the value
        // is a value-position branch — model it as control flow and bind the
        // result on the rejoin, instead of collapsing the whole decl to one block.
        const value = this.directValue(stmt);
        if (value && this.isModelableValueBranch(value)) return this.visitBindBranch(stmt, value);
        return this.visitSimple(stmt);
      }
      case 'assignment': {
        // `x = when (k) { … }` / `x = if (c) a else b` / `x = try { … }` (#2205):
        // model the RHS branch as control flow and bind the target on the rejoin.
        const branch = this.assignmentBranch(stmt);
        if (branch) return this.visitBindAssign(stmt, branch);
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

  // ── jump expressions (return / throw / break / continue) ──────────────────

  /** The leading anonymous keyword of a `jump_expression` decides its kind. */
  private jumpKeyword(stmt: SyntaxNode): string {
    const first = stmt.child(0);
    return first?.text ?? '';
  }

  private visitJump(stmt: SyntaxNode): TraversalResult {
    const kw = this.jumpKeyword(stmt);
    if (kw === 'return' || kw === 'return@') return this.visitReturn(stmt);
    if (kw === 'throw') return this.visitThrow(stmt);
    if (kw === 'break' || kw === 'break@') return this.visitBreak(stmt);
    if (kw === 'continue' || kw === 'continue@') return this.visitContinue(stmt);
    // Unknown jump — straight through (defensive; the grammar emits only the above).
    return this.visitSimple(stmt);
  }

  /** `return [expr]` / `return@label` — threads through every active finalizer. */
  private visitReturn(stmt: SyntaxNode): TraversalResult {
    // `return when (k) { … }` / `return if (c) a else b` / `return try { … }`
    // (#2205): the returned value is a value-position branch — model it as control
    // flow, with each arm returning (its value IS the function result), threading
    // finalizers per arm.
    const branch = stmt.namedChildren.find(
      (c) =>
        c.type === 'when_expression' || c.type === 'if_expression' || c.type === 'try_expression',
    );
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
    wireJumpThroughFinalizers(
      this.builder,
      idx,
      this.cfc.finalizersForReturn(),
      this.builder.exitIndex,
      'return',
    );
    return { entry: idx, exits: [] };
  }

  /** `throw e` — routes to the nearest enclosing handler (catch/finally), else EXIT. */
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

  /** The target `label` of a `break@outer` / `continue@outer` / `return@x`, if any. */
  private jumpLabel(stmt: SyntaxNode): string | undefined {
    const label = stmt.namedChildren.find((c) => c.type === 'label');
    return label ? this.stripLabel(label.text) : undefined;
  }

  /** The name of a `label` sibling (`outer@` ⇒ `outer`; jump target `outer` ⇒ `outer`). */
  private labelName(label: SyntaxNode): string | undefined {
    const id = label.namedChildren.find((c) => c.type === 'simple_identifier');
    if (id?.text) return this.stripLabel(id.text);
    return this.stripLabel(label.text) || undefined;
  }

  private stripLabel(text: string): string {
    return text.replace(/@$/, '').replace(/^@/, '').trim();
  }

  /** Take and clear the labels queued by a preceding `label` sibling. */
  private takeLabels(): string[] {
    const labels = this.pendingLabels;
    this.pendingLabels = [];
    return labels;
  }

  // ── branches ──────────────────────────────────────────────────────────────

  /**
   * The direct value expression of a `= VALUE` carrier (`property_declaration`,
   * a `function_body` expression body): the first named child after the `=`
   * token. Returns the DIRECT value only — `val x = f(when …)` yields the call,
   * not the nested `when`, so an argument-position branch is left inline (#2205).
   */
  private directValue(stmt: SyntaxNode): SyntaxNode | undefined {
    let sawEq = false;
    for (let i = 0; i < stmt.childCount; i++) {
      const c = stmt.child(i);
      if (!c) continue;
      if (c.type === '=') {
        sawEq = true;
        continue;
      }
      if (sawEq && c.isNamed && !isComment(c)) return c;
    }
    return undefined;
  }

  /**
   * Whether `node` is a value-position branch worth modeling as control flow
   * (#2205): a `when` with ≥2 arms, or an `if` that has an `else` (a value-position
   * `if` always does). A single-arm `when` / else-less `if` carries no real
   * control dependence, so it stays an inline {@link visitSimple} block.
   */
  private isModelableValueBranch(node: SyntaxNode): boolean {
    if (node.type === 'when_expression') {
      return node.namedChildren.filter((c) => c.type === 'when_entry').length >= 2;
    }
    if (node.type === 'if_expression') return this.elseNodeOf(node) !== undefined;
    // `val x = try { … } catch { … }` / `try { … } finally { … }` (#2205): a
    // value-position `try` with a `catch` OR a `finally` is a real branch — its
    // value is the body's value, a catch's value, or the body's value threaded
    // through a finalizer — so model it as control flow.
    if (node.type === 'try_expression') {
      return node.namedChildren.some((c) => c.type === 'catch_block' || c.type === 'finally_block');
    }
    return false;
  }

  /**
   * Model a value-position `when`/`if`/`try` as control flow regardless of its
   * statement/value position — {@link visitStmt}'s `isStatementPosition` gate keeps
   * value-position branches inline, so call the branch handlers directly here.
   */
  private visitBranchExpr(node: SyntaxNode): TraversalResult {
    if (node.type === 'when_expression') return this.visitWhen(node);
    if (node.type === 'try_expression') return this.visitTry(node) ?? this.visitSimple(node);
    return this.visitIf(node);
  }

  /**
   * `val x = <branch>` (#2205): visit the branch as control flow, then rejoin its
   * arms at a facts-only continuation carrying ONLY the bound name's def (the
   * subject + arm-value uses are already harvested onto the branch's blocks). The
   * arms are now control-dependent on the branch condition, and `x` is defined at
   * the join — mirrors the Rust visitor's value-position `let` handling.
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
   * The value-position branch on a plain `=` assignment RHS (`x = when (k) {…}` /
   * `x = if (c) a else b` / `x = try {…}`, #2205), or undefined. Only a plain `=`
   * (not a compound `+=`) with a modelable-branch RHS qualifies.
   */
  private assignmentBranch(stmt: SyntaxNode): SyntaxNode | undefined {
    if (stmt.type !== 'assignment') return undefined;
    const eq = stmt.children.find((c) => !c.isNamed && c.text === '=');
    if (!eq) return undefined; // compound assignment (`+=` etc.) is not a carrier
    const rhs = stmt.namedChildren.find(
      (c) => c.type !== 'directly_assignable_expression' && !isComment(c),
    );
    return rhs && this.isModelableValueBranch(rhs) ? rhs : undefined;
  }

  /**
   * `x = <branch>` (#2205): visit the RHS branch as control flow, then rejoin its
   * arms at a facts-only continuation carrying ONLY the LHS target def (the branch
   * subject + arm-value uses are already on the branch's blocks). The arms are now
   * control-dependent on the branch — mirrors the Ruby value-branch assignment.
   */
  private visitBindAssign(stmt: SyntaxNode, branch: SyntaxNode): TraversalResult {
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

  /**
   * A `fun f() = EXPR` expression body (#2205). A value-position branch is modeled
   * as control flow (each arm yields the returned function result); any other
   * expression stays one block. The caller wires entry ← ENTRY and exits → EXIT
   * with a `return` edge (the body's value is the function's result).
   */
  visitExprBody(expr: SyntaxNode): TraversalResult {
    if (this.isModelableValueBranch(expr)) return this.visitBranchExpr(expr);
    const blk = this.builder.newBlock(
      startLineOf(expr),
      endLineOf(expr),
      expr.text,
      'normal',
      this.harvest.facts(expr),
    );
    return { entry: blk, exits: [blk] };
  }

  /**
   * `if ( COND ) control_structure_body [ else (control_structure_body |
   * if_expression) ]`. The else child after the `else` keyword is either the
   * else body (`control_structure_body`) or a nested `if_expression` (`else if`).
   */
  private visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = this.parenCondition(stmt);
    const header = this.builder.newBlock(
      startLineOf(stmt),
      cond ? endLineOf(cond) : startLineOf(stmt),
      cond ? `if (${cond.text})` : 'if',
      'normal',
      cond ? this.harvest.facts(cond) : undefined,
    );

    const bodies = stmt.namedChildren.filter((c) => c.type === 'control_structure_body');
    const elseNode = this.elseNodeOf(stmt);

    const exits: number[] = [];
    const thenRes = this.visitBody(bodies[0]);
    if (thenRes) {
      this.builder.edge(header, thenRes.entry, 'cond-true');
      exits.push(...thenRes.exits);
    } else {
      exits.push(header); // empty then — true path falls through
    }

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
   * The node after the `else` keyword: a nested `if_expression` (`else if`) or the
   * else-body `control_structure_body`.
   */
  private elseNodeOf(stmt: SyntaxNode): SyntaxNode | undefined {
    let sawElse = false;
    for (let i = 0; i < stmt.childCount; i++) {
      const c = stmt.child(i);
      if (!c) continue;
      if (sawElse && c.isNamed) return c;
      if (c.type === 'else') sawElse = true;
    }
    return undefined;
  }

  /** The condition expression of an `if`/`while` (the named child between `(` and `)`). */
  private parenCondition(stmt: SyntaxNode): SyntaxNode | undefined {
    let sawOpen = false;
    for (let i = 0; i < stmt.childCount; i++) {
      const c = stmt.child(i);
      if (!c) continue;
      if (c.type === '(') {
        sawOpen = true;
        continue;
      }
      if (c.type === ')') return undefined;
      if (sawOpen && c.isNamed && !isComment(c)) return c;
    }
    return undefined;
  }

  // ── when (no fallthrough) ──────────────────────────────────────────────────

  /**
   * `when when_subject? { when_entry* }`. Arms do NOT fall through — each
   * `when_entry` body rejoins after the `when`. The subject (and each entry's
   * `when_condition` tests) evaluate before the body; their uses are harvested
   * onto the dispatch block (a later entry's test runs only when earlier ones
   * didn't match, so any binding there is a may-def).
   */
  private visitWhen(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const subject = stmt.namedChildren.find((c) => c.type === 'when_subject');
    const dispatch = this.builder.newBlock(
      startLineOf(stmt),
      subject ? endLineOf(subject) : startLineOf(stmt),
      subject ? `when ${subject.text}` : 'when',
      'normal',
      subject ? this.harvest.whenSubjectFacts(subject) : undefined,
    );
    const whenExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushSwitch(whenExit, labels);
    const entries = stmt.namedChildren.filter((c) => c.type === 'when_entry');

    // Each entry's case tests evaluate conditionally before its body.
    for (const entry of entries) {
      for (const test of this.entryConditions(entry)) {
        this.builder.attachFacts(dispatch, this.harvest.factsConditional(test));
      }
    }

    const entryResults = entries.map((e) => this.visitBody(this.entryBody(e)));
    const hasElse = entries.some((e) => this.entryIsElse(e));

    for (const res of entryResults) {
      // An EMPTY-body arm still dispatches — it falls straight to the join. Wiring
      // it (rather than skipping) keeps the dispatch from ending up with ZERO
      // successors, which would orphan whenExit and break EXIT reverse-reachability
      // (so the whole function's CDG gets dropped). The canonical trigger is an
      // all-empty `when` with an `else` arm — `when(k){0->{};else->{}}` — where the
      // no-match edge below is suppressed. The builder dedups, so this coexists
      // with the no-match edge.
      this.builder.edge(dispatch, res ? res.entry : whenExit, 'switch-case');
    }
    // A `when` with no `else` (statement position) may match no arm — the no-match
    // path falls straight to the join.
    if (!hasElse) this.builder.edge(dispatch, whenExit, 'switch-case');

    const exits: number[] = [whenExit];
    // Each non-empty arm rejoins after the when (no fallthrough); an empty arm's
    // dispatch edge already targets whenExit above.
    for (const res of entryResults) {
      if (!res) continue;
      this.builder.connect(res.exits, whenExit, 'seq');
    }

    this.cfc.pop();
    return { entry: dispatch, exits };
  }

  /** The `when_condition` test(s) of a `when_entry` (empty for an `else` arm). */
  private entryConditions(entry: SyntaxNode): SyntaxNode[] {
    return entry.namedChildren.filter((c) => c.type === 'when_condition');
  }

  /** The body `control_structure_body` of a `when_entry`. */
  private entryBody(entry: SyntaxNode): SyntaxNode | undefined {
    return entry.namedChildren.find((c) => c.type === 'control_structure_body');
  }

  /** An `else ->` arm has an `else` keyword child and no `when_condition`. */
  private entryIsElse(entry: SyntaxNode): boolean {
    return entry.children.some((c) => c.type === 'else');
  }

  // ── loops ───────────────────────────────────────────────────────────────

  /** `for ( PAT in COLLECTION ) control_structure_body`. */
  private visitFor(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const collection = this.forCollection(stmt);
    const header = this.builder.newBlock(
      startLineOf(stmt),
      collection ? endLineOf(collection) : startLineOf(stmt),
      this.forHeaderText(stmt),
      'normal',
      this.harvest.forHeadFacts(stmt),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
    const body = this.visitBody(this.loopBody(stmt));
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

  /** The iterated collection of a `for` — the named child after `in` before `)`. */
  private forCollection(stmt: SyntaxNode): SyntaxNode | undefined {
    let sawIn = false;
    for (let i = 0; i < stmt.childCount; i++) {
      const c = stmt.child(i);
      if (!c) continue;
      if (c.type === 'in') {
        sawIn = true;
        continue;
      }
      if (c.type === ')') return undefined;
      if (sawIn && c.isNamed && !isComment(c)) return c;
    }
    return undefined;
  }

  private forHeaderText(stmt: SyntaxNode): string {
    const pat = stmt.namedChildren.find(
      (c) => c.type === 'variable_declaration' || c.type === 'multi_variable_declaration',
    );
    const collection = this.forCollection(stmt);
    const p = pat?.text ?? '';
    const col = collection?.text ?? '';
    return p || col ? `for (${p} in ${col})` : 'for';
  }

  /** The loop body `control_structure_body` (the LAST one — for/while/do). */
  private loopBody(stmt: SyntaxNode): SyntaxNode | undefined {
    const all = stmt.namedChildren.filter((c) => c.type === 'control_structure_body');
    return all.length ? all[all.length - 1] : undefined;
  }

  /** `while ( COND ) control_structure_body`. */
  private visitWhile(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const cond = this.parenCondition(stmt);
    const header = this.builder.newBlock(
      startLineOf(stmt),
      cond ? endLineOf(cond) : startLineOf(stmt),
      cond ? `while (${cond.text})` : 'while',
      'normal',
      cond ? this.harvest.facts(cond) : undefined,
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, labels);
    const body = this.visitBody(this.loopBody(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-tests
    }
    // Structural exit edge — even `while (true) {}` keeps EXIT reverse-reachable.
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  /**
   * `do control_structure_body while ( COND )` — BOTTOM-TEST: the body runs at
   * least once, THEN the condition decides whether to loop back.
   */
  private visitDoWhile(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const cond = this.doWhileCondition(stmt);
    const condBlock = this.builder.newBlock(
      cond ? startLineOf(cond) : endLineOf(stmt),
      cond ? endLineOf(cond) : endLineOf(stmt),
      cond ? `while (${cond.text})` : 'while',
      'normal',
      cond ? this.harvest.facts(cond) : undefined,
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    // `continue` re-tests the condition; `break` leaves the loop.
    this.cfc.pushLoop(condBlock, loopExit, labels);
    const body = this.visitBody(this.loopBody(stmt));
    this.cfc.pop();

    const backTarget = body ? body.entry : condBlock;
    if (body) this.builder.connect(body.exits, condBlock, 'seq');
    this.builder.edge(condBlock, backTarget, 'loop-back'); // cond true → run body again
    // Structural exit edge — even `do {} while (true)` keeps EXIT reachable.
    this.builder.edge(condBlock, loopExit, 'cond-false');
    return { entry: backTarget, exits: [loopExit] };
  }

  /** The condition of a `do … while ( COND )` — the named child after the trailing `while`. */
  private doWhileCondition(stmt: SyntaxNode): SyntaxNode | undefined {
    let sawWhile = false;
    for (let i = 0; i < stmt.childCount; i++) {
      const c = stmt.child(i);
      if (!c) continue;
      if (c.type === 'while') {
        sawWhile = true;
        continue;
      }
      if (sawWhile && c.type === ')') return undefined;
      if (sawWhile && c.isNamed && !isComment(c)) return c;
    }
    return undefined;
  }

  // ── try / catch / finally ──────────────────────────────────────────────────

  /**
   * `try { statements } catch_block* finally_block?`. The `finally` runs on BOTH
   * normal and exception exit (finally semantics) — a `return`/`break`/`continue`
   * crossing it threads through and gets a `finally-*` completion edge. Mirrors
   * the Java `visitTry`.
   */
  private visitTry(stmt: SyntaxNode): SeqResult {
    const bodyNode = stmt.namedChildren.find((c) => c.type === 'statements');
    const catchBlocks = stmt.namedChildren.filter((c) => c.type === 'catch_block');
    const finallyBlock = stmt.namedChildren.find((c) => c.type === 'finally_block');
    const finallyBody = finallyBlock?.namedChildren.find((c) => c.type === 'statements');

    // The explicit finally is a finalizer the whole protected region threads through.
    const finallyRes = finallyBody ? this.visitSeq(this.statementsOf(finallyBody)) : null;
    const finallyFrame = finallyRes ? this.cfc.pushFinalizer(finallyRes.entry) : null;
    const finalizerEntry = finallyRes?.entry;
    const finalizerExits = finallyRes?.exits ?? null;

    // Build each catch handler.
    const catchEntries: number[] = [];
    const catchExits: number[] = [];
    let firstCatchEntry: number | undefined;
    for (const clause of catchBlocks) {
      const clauseBody = clause.namedChildren.find((c) => c.type === 'statements');
      if (finalizerEntry !== undefined) this.handlers.push(finalizerEntry);
      let res: SeqResult = clauseBody ? this.visitSeq(this.statementsOf(clauseBody)) : null;
      if (finalizerEntry !== undefined) this.handlers.pop();
      if (res === null) {
        // Empty `catch {}` still catches — synthesize one block so exception flow
        // lands somewhere and post-try code stays reachable.
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

    // Handler for the try body: first catch if present, else the finally, else outer.
    const tryHandler = firstCatchEntry ?? finalizerEntry ?? this.currentHandler();
    const protectedStart = this.builder.blockCount;
    this.handlers.push(tryHandler);
    let bodyRes = bodyNode ? this.visitSeq(this.statementsOf(bodyNode)) : null;
    this.handlers.pop();

    if (bodyRes === null && (catchBlocks.length > 0 || finalizerEntry !== undefined)) {
      // An empty `try {}` body still establishes a protected region. Synthesize
      // one block (like the empty-`catch` case above) so the throw-edge loop
      // wires the catch handler(s) and the try's entry is the body — otherwise
      // the catch handler block + its error binding are orphaned (unreachable
      // from ENTRY) and control routes straight to the finally, bypassing catch.
      const idx = this.builder.newBlock(startLineOf(stmt), startLineOf(stmt), '');
      bodyRes = { entry: idx, exits: [idx] };
    }

    if (catchBlocks.length > 0 || finalizerEntry !== undefined) {
      for (let b = protectedStart; b < this.builder.blockCount; b++) {
        this.builder.edge(b, tryHandler, 'throw');
      }
    }

    // Pop the finalizer frame and drain its pending completion legs.
    if (finallyFrame && finallyRes) {
      this.cfc.pop();
      drainFinalizerPending(this.builder, finallyFrame, finallyRes.exits);
    }

    const exits: number[] = [];
    if (finalizerEntry !== undefined) {
      if (bodyRes) this.builder.connect(bodyRes.exits, finalizerEntry, 'seq');
      for (const e of catchExits) this.builder.edge(e, finalizerEntry, 'seq');
      if (finalizerExits) exits.push(...finalizerExits);
      // No catch → an exception re-propagates out after the finally runs.
      if (catchBlocks.length === 0 && finalizerExits) {
        this.builder.connect(finalizerExits, this.currentHandler(), 'throw');
      }
    } else {
      if (bodyRes) exits.push(...bodyRes.exits);
      exits.push(...catchExits);
    }

    const entry = bodyRes?.entry ?? finalizerEntry ?? catchEntries[0];
    if (entry === undefined) return null;
    return { entry, exits: [...new Set(exits)] };
  }

  /** Nearest enclosing exception handler, or the function EXIT. */
  private currentHandler(): number {
    return this.handlers.length ? this.handlers[this.handlers.length - 1] : this.builder.exitIndex;
  }
}

/** The function/lambda body `statements`, or an expression body, or undefined. */
function bodyStatementsOf(fnNode: SyntaxNode): SyntaxNode | undefined {
  if (fnNode.type === 'lambda_literal') {
    return fnNode.namedChildren.find((c) => c.type === 'statements');
  }
  const fb = fnNode.namedChildren.find((c) => c.type === 'function_body');
  if (!fb) return undefined;
  // `function_body` is `{ statements }` OR an expression body `= expr`.
  const stmts = fb.namedChildren.find((c) => c.type === 'statements');
  if (stmts) return stmts;
  // Expression body — return the body itself so the caller treats it as one block.
  return fb;
}

/** Build the CFG for one Kotlin function node, or `undefined` if not modelable. */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  try {
    if (!KOTLIN_FUNCTION_TYPES.has(fnNode.type)) return undefined;
    const startLine = startLineOf(fnNode);
    const endLine = endLineOf(fnNode);
    const startColumn = fnNode.startPosition.column;

    // A `function_declaration` / `anonymous_function` needs a `function_body`; a
    // `lambda_literal` carries its `statements` directly. Absence of a body
    // container ⇒ an abstract / interface-member / signature-only declaration with
    // nothing to model (return undefined).
    const hasBody =
      fnNode.type === 'lambda_literal' ||
      fnNode.namedChildren.some((c) => c.type === 'function_body');
    if (!hasBody) return undefined;

    const body = bodyStatementsOf(fnNode);

    const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);
    const harvest = new KotlinHarvester(fnNode);

    const paramFacts = harvest.paramFacts();
    if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

    // Expression body (`fun f() = expr` / a `function_body` that is `= expr`):
    // the body's value is returned. A value-position branch (`= when (k) { … }`)
    // is modeled as control flow so each arm is control-dependent on the
    // condition (#2205); any other expression is one block.
    if (body && body.type === 'function_body') {
      const expr = body.namedChildren.find((c) => !isComment(c) && c.type !== 'statements');
      if (expr) {
        const res = new KotlinCfgWalk(builder, harvest).visitExprBody(expr);
        builder.edge(builder.entryIndex, res.entry, 'seq');
        builder.connect(res.exits, builder.exitIndex, 'return');
        return builder.finish(harvest.bindingTable());
      }
      // `function_body` with neither statements nor an expression — empty.
      builder.edge(builder.entryIndex, builder.exitIndex, 'seq');
      return builder.finish(harvest.bindingTable());
    }

    const walk = new KotlinCfgWalk(builder, harvest);
    const res = body ? walk.visitSeq(body.namedChildren.filter((c) => !isComment(c))) : null;

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
    console.warn(`[cfg] Kotlin buildFunctionCfg skipped a function in ${filePath}: ${String(err)}`);
    return undefined;
  }
}

/** Whether a node is a Kotlin function/lambda this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return KOTLIN_FUNCTION_TYPES.has(node.type);
}

/** The Kotlin CFG visitor. */
export function createKotlinCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { KOTLIN_FUNCTION_TYPES };
