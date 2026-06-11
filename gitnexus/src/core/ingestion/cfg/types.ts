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

/**
 * One distinct declared variable (binding) within a function (#2082 M2 U1).
 *
 * Statement facts reference bindings by integer index into
 * {@link FunctionCfg.bindings} — names appear once per binding instead of once
 * per occurrence (measured ~4× smaller serialized payload than named records).
 * Distinct bindings of the same name (shadowing) get distinct entries, which is
 * what keeps an inner `let x` from falsely killing the outer `x`'s definitions
 * in the reaching-defs solver. NOTE: no field here may be named `nodeId` — the
 * durable parsedfile-store reviver dedups objects keyed on that field name.
 */
export interface BindingEntry {
  /** Source-level variable name (what the persisted edge's `reason` carries). */
  readonly name: string;
  /**
   * 1-based line/0-based column of the canonical declaration site — `var`
   * multi-declarations canonicalize to the FIRST declaration in source order.
   * Both 0 for synthetic bindings.
   */
  readonly declLine: number;
  readonly declColumn: number;
  /** How the binding was introduced (param/catch matter to the M3 taint pass). */
  readonly kind: 'var' | 'let' | 'const' | 'param' | 'catch' | 'function' | 'class' | 'module';
  /**
   * True when the name has no in-function declaration site (implicit global,
   * import, or a variable captured from an enclosing function) — keyed
   * `name@module` in edge ids instead of `name:line:col`.
   */
  readonly synthetic?: boolean;
}

/**
 * Def/use facts for one harvested statement (or construct header), in
 * execution order within its block (#2082 M2 U1). `defs`/`uses` are indices
 * into {@link FunctionCfg.bindings}. A compound assignment / update expression
 * lists its binding in BOTH. Self-describing — `line` is carried here, never
 * inferred from the block's text fragments (facts-only records exist, e.g.
 * params on ENTRY and catch params).
 *
 * `mayDefs` (tri-review P1): defs harvested inside CONDITIONALLY-EVALUATED
 * subexpressions — short-circuit right operands (`a && (x = v)`,
 * `c ?? (c = load())`), ternary arms, logical-assignment operators, and
 * switch case-test expressions. The solver treats them as GEN WITHOUT KILL:
 * treating them as must-defs would falsely kill the prior def on the
 * not-taken path (a taint false negative on core JS idioms). Optional —
 * absent means none.
 */
export interface StatementFacts {
  readonly line: number;
  readonly defs: readonly number[];
  readonly uses: readonly number[];
  readonly mayDefs?: readonly number[];
}

/** A basic block: a maximal straight-line run of statements between leaders. */
export interface BasicBlockData {
  /** Block index within its function. The synthetic ENTRY is always 0. */
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  /** Source snippet for the block (empty for synthetic ENTRY/EXIT). */
  readonly text: string;
  readonly kind: 'entry' | 'exit' | 'normal';
  /**
   * Per-statement def/use facts in execution order (#2082 M2 U1). Present only
   * when the producing visitor harvests (TS/JS under `--pdg`); absent on
   * hand-built or pre-M2 CFGs — the reaching-defs solver reports `no-facts`.
   */
  readonly statements?: readonly StatementFacts[];
}

/**
 * Why one block flows to another — drives the `reason` on the emitted CFG edge.
 *
 * Kind invariant (M2): a bare jump kind (`return`/`break`/`continue`) means the
 * SOURCE block's terminator is that jump statement. A `finally-*` kind marks a
 * COMPLETION edge out of a `finally` body's exit — the leg that resumes a jump
 * which was re-routed through the finally (issue #2082 U2). Reusing the bare
 * kinds on completion edges would silently break consumers that infer the
 * source block's terminator from the kind, and a single generic kind would lose
 * WHICH jump each completion edge completes when a shared finally has several
 * pending targets.
 */
export type CfgEdgeKind =
  | 'seq' // straight-line fallthrough
  | 'cond-true' // branch taken (if/while/for condition true)
  | 'cond-false' // branch not taken / loop exit
  | 'loop-back' // back-edge to a loop header
  | 'break' // break → loop/switch exit (or the finally it must cross)
  | 'continue' // continue → loop header (or the finally it must cross)
  | 'return' // return → function EXIT (or the finally it must cross)
  | 'throw' // throw → nearest handler / finally / EXIT
  | 'switch-case' // dispatch to a case
  | 'fallthrough' // switch case → next case (no break)
  | 'finally-return' // finally exit → resumed return target (EXIT / outer finally)
  | 'finally-break' // finally exit → resumed break target
  | 'finally-continue'; // finally exit → resumed continue target

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
  /**
   * The function's binding table (#2082 M2 U1) — referenced by index from
   * {@link BasicBlockData.statements}. Present iff statement facts are.
   */
  readonly bindings?: readonly BindingEntry[];
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
