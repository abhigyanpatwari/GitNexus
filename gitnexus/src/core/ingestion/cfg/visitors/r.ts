/**
 * R CfgVisitor — control flow only (no def/use harvest).
 *
 * Walks an R `function_definition` (covers both `function(x)` and the `\(x)`
 * lambda form; the grammar uses one node type) and drives the language-agnostic
 * {@link CfgBuilder}. Shapes were checked against the @eagleoutice/tree-sitter-r
 * grammar:
 *  - `function_definition` fields `parameters` / `body`. The body is either a
 *    `braced_expression` (children carry the field `body`) or a bare expression
 *    (`function(x) x + 1`, `function(x) if (x) 1 else 2`).
 *  - `if_statement` fields `condition` / `consequence` / optional `alternative`
 *    (an `else if` chain is a nested `if_statement` in `alternative`).
 *  - `for_statement` fields `variable` / `sequence` / `body`; `while_statement`
 *    fields `condition` / `body`; `repeat_statement` field `body`.
 *  - `break` and `next` are their own node types; `return(...)` is a `call`
 *    whose `function` field is a `return` node.
 *
 * Edge-kind contract (same as the other visitors; CDG consumes it):
 *  - if / else if / else      -> `cond-true` / `cond-false`
 *  - for / while / repeat     -> `cond-true` / `loop-back` / `cond-false`
 *  - break / next / return(…) -> `break` / `continue` / `return`
 *  - straight-line            -> `seq`
 *
 * A fall-through arm (no `else`, or an empty `{}` arm) produces no block and is the
 * header's `seq` edge to the join; control dependence labels it as the complement of
 * the sibling arm's explicit `cond-true` / `cond-false`, so no branch sense is lost.
 *
 * Every loop (including `repeat` and `while (TRUE)`) gets the structural
 * `header -> loopExit` `cond-false` edge, so EXIT stays reverse-reachable and
 * the post-dominator / control-dependence pass is never skipped for a function
 * with a non-terminating loop. For `repeat` that edge is an analysis device, not
 * a real condition.
 *
 * What is modelled: statement-position `if` / `for` / `while` / `repeat` /
 * `break` / `next` / `return(...)` / bare `{ }` blocks, in function bodies and in
 * the bodies of those constructs. R functions are values, so a nested
 * `function_definition` (assigned, anonymous, or an argument) is opaque in its
 * parent's CFG and gets its own CFG from the pipeline's function collector.
 *
 * Known limitations (coverage gaps, deliberately not guessed at):
 *  - NO def/use harvest and no binding table. `finish()` is called without
 *    bindings, so the reaching-defs solver reports `no-facts` for R and emits no
 *    REACHING_DEF edges; taint `sites[]` are likewise absent.
 *  - Control flow nested inside an expression is not lowered: `y <- if (c) a
 *    else b`, a `return()` inside `tryCatch({ ... })` / `local({ ... })` /
 *    `withCallingHandlers`, `switch(...)`, `&&` / `||` short-circuits, and
 *    `ifelse()` all stay a single straight-line block.
 *  - `stop()`, `on.exit()`, `tryCatch` handlers, `Recall`, `quit()` and
 *    non-local exits (`return` from a promise, `break` from `sapply` closures)
 *    are ordinary calls: no `throw` edges, no finalizer routing.
 *  - `return` / `break` / `next` written without parentheses or as arguments
 *    (`invisible(return(x))`) are not recognised as terminators.
 *  - A `break` / `next` with no enclosing loop falls back to EXIT.
 *
 * Unlike the harvesting visitors this one does not catch internally: the
 * pipeline's `collectFunctionCfgs` isolates each function's build, and letting
 * `CfgNestingDepthError` through keeps it counted as `tooDeeplyNested`.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { CfgBuilder } from '../cfg-builder.js';
import { ControlFlowContext } from '../control-flow-context.js';
import type { TraversalResult } from '../traversal-result.js';
import type { CfgVisitor, FunctionCfg } from '../types.js';

/** R node types that own a CFG-bearing function body (`function(x)` and `\(x)`). */
const R_FUNCTION_TYPES = new Set(['function_definition']);

/** Statement node types that always break a basic block. */
const CONTROL_FLOW_TYPES = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'repeat_statement',
  'braced_expression',
  'break',
  'next',
]);

const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

/** `return(...)` is a call whose callee is the `return` keyword node. */
const isReturnCall = (n: SyntaxNode): boolean =>
  n.type === 'call' && n.childForFieldName('function')?.type === 'return';

const isControlStatement = (n: SyntaxNode): boolean =>
  CONTROL_FLOW_TYPES.has(n.type) || isReturnCall(n);

/** A statement sequence that produced no blocks (empty body) is "transparent". */
type SeqResult = TraversalResult | null;

/** Per-function walk state: one instance per function so loop frames never leak. */
class RCfgWalk {
  private readonly cfc = new ControlFlowContext();

  constructor(private readonly builder: CfgBuilder) {}

  private statementsOf(block: SyntaxNode): SyntaxNode[] {
    return block.namedChildren.filter((c) => c.type !== 'comment');
  }

  /** Visit a body that may be a `braced_expression` or a single expression. */
  private visitBody(node: SyntaxNode | undefined | null): SeqResult {
    return this.builder.withNesting(() => {
      if (!node) return null;
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
        if (isControlStatement(stmt)) {
          openSimple = undefined; // close any open straight-line block
          const res = this.visitStmt(stmt);
          if (res === null) continue; // transparent (empty `{}`)
          if (entry === undefined) entry = res.entry;
          else this.builder.connect(dangling, res.entry, 'seq');
          dangling = [...res.exits];
        } else if (openSimple === undefined) {
          const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
          if (entry === undefined) entry = idx;
          else this.builder.connect(dangling, idx, 'seq');
          openSimple = idx;
          dangling = [idx];
        } else {
          this.builder.extendBlock(openSimple, endLineOf(stmt), stmt.text);
        }
      }

      if (entry === undefined) return null;
      return { entry, exits: dangling };
    });
  }

  /** Dispatch one statement to its handler. Non-null except for an empty `{}`. */
  visitStmt(stmt: SyntaxNode): SeqResult {
    switch (stmt.type) {
      case 'if_statement':
        return this.visitIf(stmt);
      case 'for_statement':
        return this.visitFor(stmt);
      case 'while_statement':
        return this.visitWhile(stmt);
      case 'repeat_statement':
        return this.visitRepeat(stmt);
      case 'braced_expression':
        return this.visitSeq(this.statementsOf(stmt));
      case 'break':
        return this.visitJump(stmt, 'break');
      case 'next':
        return this.visitJump(stmt, 'continue');
      default:
        if (isReturnCall(stmt)) return this.visitReturn(stmt);
        return this.visitSimple(stmt);
    }
  }

  private visitSimple(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    return { entry: idx, exits: [idx] };
  }

  /** `return(expr)` -> EXIT. */
  private visitReturn(stmt: SyntaxNode): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    this.builder.edge(idx, this.builder.exitIndex, 'return');
    return { entry: idx, exits: [] };
  }

  /** `break` -> loop exit, `next` -> loop header; EXIT when no loop encloses it. */
  private visitJump(stmt: SyntaxNode, kind: 'break' | 'continue'): TraversalResult {
    const idx = this.builder.newBlock(startLineOf(stmt), endLineOf(stmt), stmt.text);
    const res = kind === 'break' ? this.cfc.resolveBreak() : this.cfc.resolveContinue();
    this.builder.edge(idx, res?.target ?? this.builder.exitIndex, kind);
    return { entry: idx, exits: [] };
  }

  /** `if (cond) a [else b]`; an `else if` chain recurses through `alternative`. */
  private visitIf(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    const header = this.builder.newBlock(startLineOf(stmt), endLineOf(cond), cond.text);

    const exits: number[] = [];
    const thenRes = this.visitBody(stmt.childForFieldName('consequence'));
    if (thenRes) {
      this.builder.edge(header, thenRes.entry, 'cond-true');
      exits.push(...thenRes.exits);
    } else {
      exits.push(header); // empty then — true path falls through
    }

    const alternative = stmt.childForFieldName('alternative');
    const elseRes = alternative ? this.visitBody(alternative) : null;
    if (elseRes) {
      this.builder.edge(header, elseRes.entry, 'cond-false');
      exits.push(...elseRes.exits);
    } else {
      exits.push(header); // no (or empty) else — false path falls through
    }

    return { entry: header, exits: [...new Set(exits)] };
  }

  /** Shared loop wiring: header tests, body loops back, structural exit edge. */
  private visitLoop(stmt: SyntaxNode, headerText: string, headerEndLine: number): TraversalResult {
    const header = this.builder.newBlock(startLineOf(stmt), headerEndLine, headerText);
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
    // Structural escape: keeps EXIT reverse-reachable even for `repeat`/`while (TRUE)`.
    this.builder.edge(header, loopExit, 'cond-false');
    return { entry: header, exits: [loopExit] };
  }

  private visitFor(stmt: SyntaxNode): TraversalResult {
    const variable = stmt.childForFieldName('variable');
    const sequence = stmt.childForFieldName('sequence');
    const text = `${variable?.text ?? ''} in ${sequence?.text ?? ''}`;
    return this.visitLoop(stmt, text, sequence ? endLineOf(sequence) : startLineOf(stmt));
  }

  private visitWhile(stmt: SyntaxNode): TraversalResult {
    const cond = stmt.childForFieldName('condition') ?? stmt;
    return this.visitLoop(stmt, cond.text, endLineOf(cond));
  }

  private visitRepeat(stmt: SyntaxNode): TraversalResult {
    return this.visitLoop(stmt, 'repeat', startLineOf(stmt));
  }
}

/**
 * Build the CFG for one R `function_definition`, or `undefined` if not modelable.
 *
 * Join key: `functionStartLine` / `functionStartColumn` are those of the
 * `function_definition` node itself (the `function` / `\` token), NOT of an
 * enclosing `f <- ` assignment. See docs/languages/r-provider.md § Control flow.
 */
function buildFunctionCfg(fnNode: SyntaxNode, filePath: string): FunctionCfg | undefined {
  if (!R_FUNCTION_TYPES.has(fnNode.type)) return undefined;
  const body = fnNode.childForFieldName('body');
  if (!body) return undefined;

  const builder = new CfgBuilder(
    filePath,
    startLineOf(fnNode),
    endLineOf(fnNode),
    fnNode.startPosition.column,
  );
  const walk = new RCfgWalk(builder);
  const res = walk.visitStmt(body);
  if (!res) {
    builder.edge(builder.entryIndex, builder.exitIndex, 'seq'); // empty body
    return builder.finish();
  }
  builder.edge(builder.entryIndex, res.entry, 'seq');
  builder.connect(res.exits, builder.exitIndex, 'seq'); // normal fall-off -> EXIT
  return builder.finish();
}

/** Whether a node is an R function this visitor builds a CFG for. */
function isFunction(node: SyntaxNode): boolean {
  return R_FUNCTION_TYPES.has(node.type);
}

/** The R CFG visitor. */
export function createRCfgVisitor(): CfgVisitor<SyntaxNode> {
  return { buildFunctionCfg, isFunction };
}

export { R_FUNCTION_TYPES };
