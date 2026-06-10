/**
 * TS/JS CfgVisitor (issue #2081, M1).
 *
 * Walks a TypeScript/JavaScript function's tree-sitter AST and drives the
 * language-agnostic {@link CfgBuilder} to produce a serializable
 * {@link FunctionCfg}. TS and JS share a grammar family (tree-sitter-typescript
 * reuses tree-sitter-javascript's statement nodes), so one visitor covers both.
 *
 * Design — a `visit_<node_type>` dispatch over the statement taxonomy. The
 * classic CFG hazards (R10) are handled explicitly:
 *  - loops allocate a dedicated **loop-exit** block so `break` has a concrete
 *    target before the loop's successor is known; `continue` targets the
 *    header/increment; the back-edge closes the loop.
 *  - `switch` cases fall through naturally: a case body that does not `break`
 *    yields non-empty `exits`, which we wire to the next case as `fallthrough`;
 *    a case that `break`s wires to the switch exit (via {@link ControlFlowContext})
 *    and yields no fall-out.
 *  - `try/catch/finally` routes both normal completion AND a `throw` in the try
 *    through `finally` (the finally block post-dominates the try/catch); a
 *    `throw` with no catch propagates through finally to the enclosing handler.
 *  - labeled `break`/`continue` resolve against the labeled loop's frame.
 *
 * Known M1 limitations:
 *  - SOUNDNESS GAP (M2 blocker, not mere precision): a non-local jump
 *    (`break`/`continue`/`return`) out of a `try` that has a `finally` edges
 *    directly to its target rather than routing THROUGH the `finally` block
 *    first. A future taint/PDG pass will therefore MISS flow mediated by a
 *    `finally` on the early-exit path (e.g. a value the `finally` taints or
 *    sanitizes before the `return` reaches its target) — a false negative. The
 *    general fix duplicates `finally` per exit path; deferred past M1 and
 *    tracked for M2. Normal completion and `throw` DO route through `finally`.
 *  - A `break`/`continue` to a label on a non-loop/non-switch block, and the
 *    OUTER label of a doubly-labeled construct (`outer: inner: for (...)`), are
 *    not modeled. The jump is conservatively routed to the function EXIT (a
 *    sound over-approximation that keeps the graph single-exit — see visitBreak)
 *    rather than left as a dangling sink; only the precise labeled target is
 *    unmodeled. Single-labeled loops/switches resolve correctly.
 *
 * Block/edge accounting and reachability are pinned in
 * `test/unit/cfg/cfg-builder.test.ts` (core) and
 * `test/unit/cfg/typescript-visitor.test.ts` (this visitor, per hazard).
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import { ControlFlowContext } from '../control-flow-context.js';
import type { TraversalResult } from '../traversal-result.js';
import type { CfgVisitor, FunctionCfg } from '../types.js';

/** TS/JS node types that own a CFG-bearing function body. */
const TS_FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function',
  'async_function_declaration',
  'async_arrow_function',
]);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'switch_statement',
  'try_statement',
  'return_statement',
  'break_statement',
  'continue_statement',
  'throw_statement',
  'labeled_statement',
  'statement_block',
]);

const LOOP_OR_SWITCH_TYPES = new Set([
  'while_statement',
  'do_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'switch_statement',
]);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/**
 * Per-function walk state. One instance is created per function so the
 * {@link ControlFlowContext}, exception-handler stack, and pending label are
 * scoped to that function and never leak across functions.
 */
class TsCfgWalk {
  private readonly cfc = new ControlFlowContext();
  /** Stack of exception-handler entry blocks (catch/finally) a `throw` jumps to. */
  private readonly handlers: number[] = [];
  /** Label awaiting the loop/switch it immediately precedes (labeled_statement). */
  private pendingLabel: string | undefined;

  constructor(private readonly builder: CfgBuilder) {}

  /** Statements of a block node, ignoring comments. */
  private statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter((c) => c.type !== 'comment');
  }

  /** The `body` block of a node (field, or the first statement_block child). */
  private bodyBlockOf(node: SyntaxNode): SyntaxNode | undefined {
    return (
      node.childForFieldName('body') ?? node.namedChildren.find((c) => c.type === 'statement_block')
    );
  }

  /** Visit a body that may be a `statement_block` or a single statement. */
  private visitBody(node: SyntaxNode | undefined | null): SeqResult {
    if (!node) return null;
    if (node.type === 'statement_block') return this.visitSeq(this.statementsOf(node));
    return this.visitStmt(node);
  }

  /** Wire a sequence of statements, coalescing straight-line runs into blocks. */
  visitSeq(stmts: SyntaxNode[]): SeqResult {
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
        // Simple statement — coalesce into the current straight-line block.
        if (openSimple === undefined) {
          const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
          if (entry === undefined) entry = idx;
          else this.builder.connect(dangling, idx, 'seq');
          openSimple = idx;
          dangling = [idx];
        } else {
          this.builder.extendBlock(openSimple, endLineOf(stmt), stmt.text);
        }
      }
    }

    if (entry === undefined) return null;
    return { entry, exits: dangling };
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
      case 'for_in_statement':
      case 'for_of_statement':
        return this.visitForIn(stmt);
      case 'switch_statement':
        return this.visitSwitch(stmt);
      case 'try_statement':
        return this.visitTry(stmt);
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
      case 'statement_block':
        return this.visitSeq(this.statementsOf(stmt));
      default:
        return this.visitSimple(stmt);
    }
  }

  private visitSimple(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    return { entry: idx, exits: [idx] };
  }

  private visitReturn(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    this.builder.edge(idx, this.builder.exitIndex, 'return');
    return { entry: idx, exits: [] };
  }

  private visitThrow(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    this.builder.edge(idx, this.currentHandler(), 'throw');
    return { entry: idx, exits: [] };
  }

  private visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const target = this.cfc.breakTarget(this.labelOf(stmt));
    // An unresolved target — a label this M1 visitor doesn't model (a stacked
    // outer label like `outer: inner: for`, or a labeled non-loop block) —
    // would otherwise leave this block with NO out-edge, stranding it and
    // breaking the single-exit invariant a downstream post-dominator / PDG pass
    // relies on. Conservatively route an unresolved jump to the function EXIT
    // ("escapes the function"): sound over-approximation, keeps single-exit.
    this.builder.edge(idx, target ?? this.builder.exitIndex, 'break');
    return { entry: idx, exits: [] };
  }

  private visitContinue(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const target = this.cfc.continueTarget(this.labelOf(stmt));
    // See visitBreak: an unresolved label routes to EXIT to preserve single-exit.
    this.builder.edge(idx, target ?? this.builder.exitIndex, 'continue');
    return { entry: idx, exits: [] };
  }

  private visitLabeled(stmt: SyntaxNode): SeqResult {
    const body =
      stmt.childForFieldName('body') ?? stmt.namedChildren[stmt.namedChildren.length - 1];
    if (body && LOOP_OR_SWITCH_TYPES.has(body.type)) {
      this.pendingLabel = this.labelOf(stmt);
      const res = this.visitStmt(body);
      this.pendingLabel = undefined; // clear even if the construct didn't consume it
      return res;
    }
    // Labeled non-loop blocks (break-to-block-label) are not modeled in M1.
    return this.visitBody(body);
  }

  private visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const condBlock = this.builder.newBlock(startLineOf(stmt), endLineOf(cond), cond.text);

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
        exits.push(condBlock); // empty else block
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
    return alt;
  }

  private visitWhile(stmt: SyntaxNode): TraversalResult {
    const label = this.takeLabel();
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(startLineOf(stmt), endLineOf(cond), cond.text);
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, label);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      this.builder.connect(body.exits, header, 'loop-back');
    } else {
      this.builder.edge(header, header, 'loop-back'); // empty body re-tests
    }
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private visitDoWhile(stmt: SyntaxNode): TraversalResult {
    const label = this.takeLabel();
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const condBlock = this.builder.newBlock(startLineOf(cond), endLineOf(cond), cond.text);
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(condBlock, loopExit, label);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    const backTarget = body ? body.entry : condBlock;
    if (body) this.builder.connect(body.exits, condBlock, 'seq');
    this.builder.edge(condBlock, backTarget, 'loop-back'); // cond true → run body again
    this.builder.edge(condBlock, loopExit, 'cond-false');
    return { entry: backTarget, exits: [loopExit] };
  }

  private visitFor(stmt: SyntaxNode): TraversalResult {
    const label = this.takeLabel();
    const init = stmt.childForFieldName('initializer');
    const cond = stmt.childForFieldName('condition');
    const incr = stmt.childForFieldName('increment');

    const header = this.builder.newBlock(
      startLineOf(stmt),
      cond ? endLineOf(cond) : startLineOf(stmt),
      cond ? cond.text : 'for(;;)',
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    let incrBlock = header;
    if (incr) {
      incrBlock = this.builder.newBlock(startLineOf(incr), endLineOf(incr), incr.text);
      this.builder.edge(incrBlock, header, 'loop-back');
    }

    this.cfc.pushLoop(incrBlock, loopExit, label);
    const body = this.visitBody(this.bodyBlockOf(stmt));
    this.cfc.pop();

    if (body) {
      this.builder.edge(header, body.entry, 'cond-true');
      // With no increment clause the body's exits ARE the back-edge — carry
      // the loop-back kind on them (mirroring visitWhile/visitForIn) instead
      // of a phantom header→header self-loop that models a path which never
      // executes the body. With an increment, the body falls through to the
      // increment (`seq`) and the increment carries the loop-back (:338).
      this.builder.connect(body.exits, incrBlock, incr ? 'seq' : 'loop-back');
    } else {
      this.builder.edge(header, incrBlock, 'cond-true');
      // Empty body with no increment: the header genuinely re-tests itself.
      if (!incr) this.builder.edge(header, header, 'loop-back');
    }
    this.builder.edge(header, loopExit, 'cond-false');

    let entry = header;
    if (init) {
      const initBlock = this.builder.newBlock(startLineOf(init), endLineOf(init), init.text);
      this.builder.edge(initBlock, header, 'seq');
      entry = initBlock;
    }
    return { entry, exits: [loopExit] };
  }

  private visitForIn(stmt: SyntaxNode): TraversalResult {
    const label = this.takeLabel();
    const header = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      this.forInHeaderText(stmt),
    );
    const loopExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushLoop(header, loopExit, label);
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

  private forInHeaderText(stmt: SyntaxNode): string {
    const left = stmt.childForFieldName('left')?.text ?? '';
    const right = stmt.childForFieldName('right')?.text ?? '';
    return left || right ? `for(${left} … ${right})` : 'for(… in/of …)';
  }

  private visitSwitch(stmt: SyntaxNode): TraversalResult {
    const label = this.takeLabel();
    const value = stmt.childForFieldName('value') ?? stmt;
    const dispatch = this.builder.newBlock(startLineOf(stmt), endLineOf(value), value.text);
    const switchExit = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');

    this.cfc.pushSwitch(switchExit, label);
    const body = stmt.childForFieldName('body');
    const cases = body
      ? body.namedChildren.filter((c) => c.type === 'switch_case' || c.type === 'switch_default')
      : [];

    const caseResults = cases.map((c) => this.visitSeq(this.caseStatements(c)));
    const hasDefault = cases.some((c) => c.type === 'switch_default');

    // entryOf[i] = block a dispatch/fallthrough INTO case i lands on (empty
    // cases are transparent — they resolve to the next case, or the exit).
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

    this.cfc.pop();
    return { entry: dispatch, exits: [switchExit] };
  }

  private caseStatements(caseNode: SyntaxNode): SyntaxNode[] {
    const value = caseNode.childForFieldName('value');
    return caseNode.namedChildren.filter((c) => c.id !== value?.id && c.type !== 'comment');
  }

  private visitTry(stmt: SyntaxNode): SeqResult {
    const bodyNode = stmt.childForFieldName('body');
    // Single pass over named children — tree-sitter's `namedChildren` getter
    // allocates a fresh array on every access, so avoid the double `.find`.
    let catchClause: SyntaxNode | undefined;
    let finallyClause: SyntaxNode | undefined;
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const c = stmt.namedChild(i);
      if (c?.type === 'catch_clause') catchClause = c;
      else if (c?.type === 'finally_clause') finallyClause = c;
    }

    // Build finally first so its entry is known as both a normal join and a
    // handler target. The finally body runs in the OUTER handler context.
    const finallyRes = finallyClause
      ? this.visitSeq(this.statementsOf(this.bodyBlockOf(finallyClause) as SyntaxNode))
      : null;

    // A throw inside catch propagates to finally (if any), else the outer handler.
    let catchRes: SeqResult = null;
    if (catchClause) {
      if (finallyRes) this.handlers.push(finallyRes.entry);
      catchRes = this.visitSeq(this.statementsOf(this.bodyBlockOf(catchClause) as SyntaxNode));
      if (finallyRes) this.handlers.pop();
      if (catchRes === null) {
        // Empty (or comment-only) catch body — `catch {}`. The clause still
        // CATCHES: handler semantics key off the syntactic clause, not the
        // traversal result. Treating it as "no catch" sent the swallowed
        // exception to the outer handler/EXIT and left post-try code
        // unreachable when the body always throws — a hard false-negative
        // for downstream taint. Synthesize one empty block spanning the
        // clause (entry == sole exit) so exception flow lands in it and
        // rejoins the normal continuation. Created BEFORE the protected
        // region is walked, so it never receives a spurious throw edge.
        const idx = this.builder.newBlock(startLineOf(catchClause), endLineOf(catchClause), '');
        catchRes = { entry: idx, exits: [idx] };
      }
    }

    // Handler for the try body: catch if present, else finally, else outer.
    const tryHandler = catchRes?.entry ?? finallyRes?.entry ?? this.currentHandler();
    const protectedStart = this.builder.blockCount;
    this.handlers.push(tryHandler);
    const bodyRes = bodyNode ? this.visitSeq(this.statementsOf(bodyNode)) : null;
    this.handlers.pop();

    // Conservative exceptional edges: ANY block in the protected region may raise
    // to the handler — not just an explicit `throw`, and not just the body ENTRY.
    // Edging every block created during the try-body walk keeps exception flow
    // sound when the body BRANCHES: an `if` / nested-try / post-branch block whose
    // interior blocks would otherwise have no path to the handler — i.e. a taint
    // false-negative into `catch` for the downstream PDG analysis. The
    // per-function edge cap bounds the count; explicit `throw`s add their own
    // (idempotent) edge to the same handler.
    if (catchClause || finallyClause) {
      for (let b = protectedStart; b < this.builder.blockCount; b++) {
        this.builder.edge(b, tryHandler, 'throw');
      }
    }

    const exits: number[] = [];
    if (finallyRes) {
      // Normal completion of try AND catch both flow through finally.
      if (bodyRes) this.builder.connect(bodyRes.exits, finallyRes.entry, 'seq');
      if (catchRes) this.builder.connect(catchRes.exits, finallyRes.entry, 'seq');
      exits.push(...finallyRes.exits);
      // No catch → an exception re-propagates out after finally runs.
      if (!catchRes) this.builder.connect(finallyRes.exits, this.currentHandler(), 'throw');
    } else {
      if (bodyRes) exits.push(...bodyRes.exits);
      if (catchRes) exits.push(...catchRes.exits);
    }

    const entry = bodyRes?.entry ?? finallyRes?.entry ?? catchRes?.entry;
    if (entry === undefined) return null;
    return { entry, exits: [...new Set(exits)] };
  }

  /** Nearest enclosing exception handler, or the function EXIT. */
  private currentHandler(): number {
    return this.handlers.length ? this.handlers[this.handlers.length - 1] : this.builder.exitIndex;
  }

  /** Consume the label awaiting the loop/switch this call is building. */
  private takeLabel(): string | undefined {
    const label = this.pendingLabel;
    this.pendingLabel = undefined;
    return label;
  }

  private labelOf(stmt: SyntaxNode): string | undefined {
    const id =
      stmt.childForFieldName('label') ??
      stmt.namedChildren.find((c) => c.type === 'statement_identifier');
    return id?.text;
  }
}

/** Build the CFG for one TS/JS function node (or `undefined` if not a function). */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  if (!TS_FUNCTION_TYPES.has(fnNode.type)) return undefined;
  const startLine = startLineOf(fnNode);
  const endLine = endLineOf(fnNode);
  const startColumn = fnNode.startPosition.column;
  const builder = new CfgBuilder(filePath, startLine, endLine, startColumn);

  const body = fnNode.childForFieldName('body');
  if (!body) return undefined; // overload signature / abstract method — no body

  if (body.type !== 'statement_block') {
    // Expression-bodied arrow: `() => expr` — one block whose value is returned.
    const blk = builder.newBlock(startLineOf(body), endLineOf(body), body.text);
    builder.edge(builder.entryIndex, blk, 'seq');
    builder.edge(blk, builder.exitIndex, 'return');
    return builder.finish();
  }

  const walk = new TsCfgWalk(builder);
  const res = walk.visitSeq(body.namedChildren.filter((c) => c.type !== 'comment'));
  if (!res) {
    builder.edge(builder.entryIndex, builder.exitIndex, 'seq'); // empty body
    return builder.finish();
  }
  builder.edge(builder.entryIndex, res.entry, 'seq');
  builder.connect(res.exits, builder.exitIndex, 'seq'); // normal fall-off → EXIT
  return builder.finish();
}

/** Whether a node is a TS/JS function this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return TS_FUNCTION_TYPES.has(node.type);
}

/** The TS/JS CFG visitor (shared by TypeScript and JavaScript). */
export function createTypeScriptCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { TS_FUNCTION_TYPES };
