/**
 * CFG data model — plain, JSON-serializable types (issue #2081, M1).
 *
 * These cross the worker→main boundary and the disk-backed/durable ParsedFile
 * store, so they must contain NO tree-sitter AST references, class instances,
 * or anything that does not survive `JSON.stringify` → `JSON.parse`. Block and
 * edge endpoints are referenced by integer index within a function's CFG.
 *
 * The per-language `CfgVisitor` (built in the parse worker, where the AST
 * lives — see the M1 plan KTD1/KTD7) produces a `FunctionCfg` per function; the
 * array of them is what rides on `ParsedFile.cfgSideChannel`.
 */

/** A basic block: a maximal straight-line run of statements between leaders. */
export interface BasicBlockData {
  /** Block index within its function. The synthetic ENTRY is always 0. */
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  /** Source snippet for the block (empty for synthetic ENTRY/EXIT). */
  readonly text: string;
  readonly kind: 'entry' | 'exit' | 'normal';
}

/** Why one block flows to another — drives the `reason` on the emitted CFG edge. */
export type CfgEdgeKind =
  | 'seq' // straight-line fallthrough
  | 'cond-true' // branch taken (if/while/for condition true)
  | 'cond-false' // branch not taken / loop exit
  | 'loop-back' // back-edge to a loop header
  | 'break' // break → loop/switch exit
  | 'continue' // continue → loop header
  | 'return' // return → function EXIT
  | 'throw' // throw → nearest handler / finally / EXIT
  | 'switch-case' // dispatch to a case
  | 'fallthrough'; // switch case → next case (no break)

export interface CfgEdgeData {
  readonly from: number;
  readonly to: number;
  readonly kind: CfgEdgeKind;
}

/** One function's control-flow graph. `cfgSideChannel` is `readonly FunctionCfg[]`. */
export interface FunctionCfg {
  readonly filePath: string;
  /** Source span of the owning function — anchors the BasicBlock node ids. */
  readonly functionStartLine: number;
  readonly functionEndLine: number;
  /**
   * Start COLUMN of the owning function. Combined with `functionStartLine` it
   * disambiguates the BasicBlock node ids when two functions share a start line
   * — e.g. `{ a: () => x(), b: () => y() }`, where both arrows begin on the same
   * line and each restarts its block indices at 0. Without the column the ids
   * collide and the graph's first-writer-wins `addNode` silently drops the
   * second function's blocks and cross-wires its edges.
   */
  readonly functionStartColumn: number;
  readonly entryIndex: number;
  readonly exitIndex: number;
  readonly blocks: readonly BasicBlockData[];
  readonly edges: readonly CfgEdgeData[];
}

/**
 * Per-language CFG strategy. Invoked **in the parse worker** for each function
 * node. `TNode` is the language's AST node type (tree-sitter `SyntaxNode` for
 * TS/JS) — kept generic so this module stays AST-library-agnostic. Returns
 * `undefined` when the node is not a CFG-bearing function (the caller skips it).
 */
export interface CfgVisitor<TNode = unknown> {
  buildFunctionCfg(fnNode: TNode, filePath: string): FunctionCfg | undefined;

  /**
   * Whether `node` is a CFG-bearing function this visitor handles. Lets the
   * worker enumerate functions (and apply the per-function line budget) by a
   * cheap node-type test, instead of attempting to build a CFG for every AST
   * node. `buildFunctionCfg` still re-checks, so this is purely an optimization
   * + the seam the line-budget hooks into.
   */
  isFunction(node: TNode): boolean;
}
