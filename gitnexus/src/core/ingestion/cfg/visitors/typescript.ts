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
 *  - EARLY EXITS THROUGH FINALLY (#2082 M2 U2, closes the M1 soundness gap): a
 *    `break`/`continue`/`return` whose jump CROSSES a `finally` is re-routed to
 *    the finally entry (keeping its bare jump kind), and the finally's exits
 *    gain a `finally-return`/`finally-break`/`finally-continue` completion edge
 *    to the resumed target. Threading is TARGET-RELATIVE via finalizer frames
 *    interleaved on the {@link ControlFlowContext} stack: only the finallys
 *    lexically between the jump and its target thread (a `break` whose loop is
 *    wholly inside the try keeps its direct edge — re-routing it would let a
 *    finally redefinition falsely kill in-loop defs for reaching-defs). Nested
 *    finallys chain inner→outer; finally-as-shared-join conflates exit paths
 *    (sound over-approximation; duplication-per-exit-path was rejected). An
 *    empty/comment-only finally pushes no frame — jumps keep direct edges.
 *  - labeled `break`/`continue` resolve against the labeled construct's frame:
 *    loops/switches carry their full label LIST (`outer: inner: for` resolves
 *    both), and a labeled NON-loop statement (`blk: { … break blk; … }`) gets
 *    a break-target frame whose target is a synthesized join after the body —
 *    the M1 route-to-EXIT fallback removed the real continuation and falsely
 *    killed defs for reaching-defs (tri-review P1).
 *
 * Known limitations:
 *  - A jump whose label STILL fails to resolve (malformed source) keeps the
 *    conservative route-to-EXIT + thread-all-finallys fallback in
 *    visitBreak/visitContinue — single-exit preserved, no finally bypassed,
 *    but the continuation path is approximate.
 *  - Exceptional flow stays the sound over-approximation: EVERY protected-region
 *    block edges to the handler (an exception may fire mid-block), which
 *    over-supplies reaching-defs facts into `catch` — extra facts, never false
 *    kills. Per-leader throw precision is deliberately deferred (M3 decides).
 *  - Def/use harvest scope (#2082 M2, see typescript-harvest.ts for the full
 *    v1 semantics table): member/property writes are not scalar defs; nested
 *    function bodies are opaque in BOTH directions (writes to and reads of
 *    captured outer variables are invisible — callback flows are M4 territory);
 *    `case x:` test uses attach to the switch dispatch block (sound
 *    over-approximation of in-order case evaluation).
 *
 * Block/edge accounting and reachability are pinned in
 * `test/unit/cfg/cfg-builder.test.ts` (core) and
 * `test/unit/cfg/typescript-visitor.test.ts` (this visitor, per hazard).
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
import { TsHarvester } from './typescript-harvest.js';

/** TS/JS node types that own a CFG-bearing function body. */
const TS_FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function',
]);

/** Statement node types that break a basic block (everything else coalesces). */
const CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'for_in_statement',
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
  /** Labels awaiting the construct they precede (`outer: inner: for` = both). */
  private pendingLabels: string[] = [];

  constructor(
    private readonly builder: CfgBuilder,
    /** Def/use fact extractor (#2082 M2 U1) — phase-2 only; its scope tree is
     *  already complete, so any walk order resolves names correctly. */
    private readonly harvest: TsHarvester,
  ) {}

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
    return this.builder.withNesting(() => {
      if (!node) return null;
      if (node.type === 'statement_block') return this.visitSeq(this.statementsOf(node));
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
          // Simple statement — coalesce into the current straight-line block.
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
      case 'for_in_statement':
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
    // Harvest the argument expression's uses — `return x` blocks live in this
    // dedicated handler, not visitSeq, and were a silently-missed site once.
    const idx = this.builder.newBlock(
      startLineOf(stmt),
      endLineOf(stmt),
      stmt.text,
      'normal',
      this.harvest.facts(stmt),
    );
    // A return crosses EVERY active finally before reaching EXIT.
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

  private visitBreak(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const res = this.cfc.resolveBreak(this.labelOf(stmt));
    // An unresolved target — a label this visitor doesn't model (a stacked
    // outer label like `outer: inner: for`, or a labeled non-loop block) —
    // would otherwise leave this block with NO out-edge, stranding it and
    // breaking the single-exit invariant a downstream post-dominator / PDG pass
    // relies on. Conservatively route an unresolved jump to the function EXIT
    // ("escapes the function") and thread ALL active finallys — a superset of
    // the truly-crossed set (the real target is somewhere in the function, so
    // execution provably runs every finally between the jump and wherever it
    // lands... up to the ones the conservative EXIT routing over-includes).
    // Sound for dataflow either way: extra paths, never a bypassed finally.
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'break');
    return { entry: idx, exits: [] };
  }

  private visitContinue(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const res = this.cfc.resolveContinue(this.labelOf(stmt));
    // See visitBreak: an unresolved label routes to EXIT (threading all
    // active finallys) to preserve single-exit without bypassing a finally.
    const { target, finalizers } = res ?? {
      target: this.builder.exitIndex,
      finalizers: this.cfc.finalizersForReturn(),
    };
    wireJumpThroughFinalizers(this.builder, idx, finalizers, target, 'continue');
    return { entry: idx, exits: [] };
  }

  private visitLabeled(stmt: SyntaxNode): SeqResult {
    const body =
      stmt.childForFieldName('body') ?? stmt.namedChildren[stmt.namedChildren.length - 1];
    const label = this.labelOf(stmt);
    if (body && (LOOP_OR_SWITCH_TYPES.has(body.type) || body.type === 'labeled_statement')) {
      // Loop/switch consumes the accumulated labels via takeLabels(); a nested
      // labeled_statement keeps accumulating (`outer: inner: for` → both
      // labels land on the loop frame).
      if (label) this.pendingLabels.push(label);
      const res = this.visitStmt(body);
      this.pendingLabels = []; // clear leftovers if the construct didn't consume
      return res;
    }
    // Labeled NON-loop statement (`blk: { … break blk; … }`): break-to-label
    // targets a synthesized join after the body. Routing it to EXIT instead
    // (the M1 behavior) removed the real continuation and falsely killed
    // every def live at the jump for post-construct uses (tri-review P1).
    const labels = [...this.pendingLabels, ...(label ? [label] : [])];
    this.pendingLabels = [];
    const join = this.builder.newBlock(endLineOf(stmt), endLineOf(stmt), '');
    this.cfc.pushLabeledBlock(join, labels);
    const res = this.visitBody(body);
    this.cfc.pop();
    if (res) this.builder.connect(res.exits, join, 'seq');
    return { entry: res?.entry ?? join, exits: [join] };
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
    const labels = this.takeLabels();
    const cond = stmt.childForFieldName('condition') ?? stmt;
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
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private visitDoWhile(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const cond = stmt.childForFieldName('condition') ?? stmt;
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
    const init = stmt.childForFieldName('initializer');
    const cond = stmt.childForFieldName('condition');
    const incr = stmt.childForFieldName('increment');

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

  private visitForIn(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    // Header text is SYNTHESIZED, so facts come from the left/right AST nodes
    // directly (the loop variable is a def, the iterated expression a use).
    const header = this.builder.newBlock(
      startLineOf(stmt),
      startLineOf(stmt),
      this.forInHeaderText(stmt),
      'normal',
      this.harvest.forInHeadFacts(stmt),
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

  private forInHeaderText(stmt: SyntaxNode): string {
    const left = stmt.childForFieldName('left')?.text ?? '';
    const right = stmt.childForFieldName('right')?.text ?? '';
    return left || right ? `for(${left} … ${right})` : 'for(… in/of …)';
  }

  private visitSwitch(stmt: SyntaxNode): TraversalResult {
    const labels = this.takeLabels();
    const value = stmt.childForFieldName('value') ?? stmt;
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
    const cases = body
      ? body.namedChildren.filter((c) => c.type === 'switch_case' || c.type === 'switch_default')
      : [];

    // `case x:` test expressions live in no block (caseStatements filters the
    // value node out) — harvest their uses onto the dispatch block, one record
    // per case in source order (a sound over-approximation of JS's in-order
    // case evaluation). Conditionally: a later case test only evaluates when
    // earlier cases didn't match, so any def inside one is a may-def — as a
    // must-def on the always-executed dispatch block it would falsely kill
    // prior defs for earlier-matching arms (tri-review).
    for (const c of cases) {
      const caseValue = c.childForFieldName('value');
      if (caseValue) this.builder.attachFacts(dispatch, this.harvest.factsConditional(caseValue));
    }

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
    // handler target. The finally body runs in the OUTER handler context — and
    // OUTSIDE this try's finalizer frame: a return inside the finally must not
    // thread itself (it threads only outer finallys, matching JS semantics).
    const finallyRes = finallyClause
      ? this.visitSeq(this.statementsOf(this.bodyBlockOf(finallyClause) as SyntaxNode))
      : null;

    // Finalizer frame for early-exit threading (#2082 M2 U2): active while the
    // catch and protected bodies are walked, so a crossing `return`/`break`/
    // `continue` inside either routes through the finally. An empty/comment-only
    // finally (`finallyRes` null — the #2099-F2 empty-catch bug shape) pushes
    // NO frame: it can define nothing, so jumps soundly keep direct edges.
    const finFrame = finallyRes ? this.cfc.pushFinalizer(finallyRes.entry) : null;

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
      // `catch (e)` has no header block — the param def gets its OWN
      // facts-only block in front of the body entry. It must NOT be prepended
      // into the body's entry block: when the catch body STARTS with a loop,
      // that entry is the loop HEADER, re-entered on every iteration — the
      // param def would re-gen there and falsely KILL loop-carried
      // redefinitions of the param (`catch (e) { while (c) { e = fix(e); }
      // sink(e); }` would lose the fix→sink fact, a taint false negative).
      // The param block becomes the handler entry, which is also semantically
      // right: the binding happens exactly once, on handler entry.
      const paramFacts = this.harvest.catchParamFacts(catchClause);
      if (paramFacts) {
        const paramBlock = this.builder.newBlock(
          startLineOf(catchClause),
          startLineOf(catchClause),
          '',
          'normal',
          paramFacts,
        );
        this.builder.edge(paramBlock, catchRes.entry, 'seq');
        catchRes = { entry: paramBlock, exits: catchRes.exits };
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

    // The finalizer frame closes once the protected/catch walks are done; any
    // jumps that crossed it left their completion legs on `pending`, wired
    // here from the finally's exits (see drainFinalizerPending for the
    // finally-override semantics of an always-jumping finally).
    if (finFrame && finallyRes) {
      this.cfc.pop();
      drainFinalizerPending(this.builder, finFrame, finallyRes.exits);
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

  /** Consume the labels awaiting the loop/switch this call is building. */
  private takeLabels(): string[] {
    const labels = this.pendingLabels;
    this.pendingLabels = [];
    return labels;
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

  // Phase-1 declaration pre-scan (#2082 M2 U1) — must complete before any
  // facts are extracted; the CFG walk below is not source-order.
  const harvest = new TsHarvester(fnNode);

  // Parameters define at ENTRY (facts only — never touch the entry block's
  // text or span: bench fingerprints and CFG snapshots include block text).
  const paramFacts = harvest.paramFacts();
  if (paramFacts) builder.attachFacts(builder.entryIndex, paramFacts);

  if (body.type !== 'statement_block') {
    // Expression-bodied arrow: `() => expr` — one block whose value is returned.
    // Lives outside the walk class, so it harvests explicitly.
    const blk = builder.newBlock(
      startLineOf(body),
      endLineOf(body),
      body.text,
      'normal',
      harvest.facts(body),
    );
    builder.edge(builder.entryIndex, blk, 'seq');
    builder.edge(blk, builder.exitIndex, 'return');
    return builder.finish(harvest.table());
  }

  const walk = new TsCfgWalk(builder, harvest);
  const res = walk.visitSeq(body.namedChildren.filter((c) => c.type !== 'comment'));
  if (!res) {
    builder.edge(builder.entryIndex, builder.exitIndex, 'seq'); // empty body
    return builder.finish(harvest.table());
  }
  builder.edge(builder.entryIndex, res.entry, 'seq');
  builder.connect(res.exits, builder.exitIndex, 'seq'); // normal fall-off → EXIT
  return builder.finish(harvest.table());
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
