/**
 * CfgBuilder (issue #2081, M1) — the language-agnostic accumulator.
 *
 * A per-language `CfgVisitor` drives this: it creates blocks as it walks
 * statements, wires edges (including back-edges and break/continue/return/throw
 * targets resolved via {@link ControlFlowContext}), and calls {@link finish} to
 * produce the serializable {@link FunctionCfg}. The builder owns the synthetic
 * ENTRY (index 0) and EXIT blocks and de-duplicates identical edges so repeated
 * `connect` calls (common when wiring a set of dangling exits) stay idempotent.
 *
 * It has no knowledge of any AST — it is exercised directly in unit tests with
 * hand-built block sequences, which is how the classic CFG hazards are pinned
 * before the tree-sitter visitor (U2) drives it.
 */
import type {
  BasicBlockData,
  BindingEntry,
  CfgEdgeData,
  CfgEdgeKind,
  FunctionCfg,
  StatementFacts,
} from './types.js';

interface MutableBlock {
  startLine: number;
  endLine: number;
  /**
   * Block source accumulated as fragments, joined once in {@link finish}. A
   * coalescing straight-line run appends one fragment per statement; storing
   * them as an array and joining at the end keeps that O(n) instead of the
   * O(n²) of repeatedly concatenating onto a growing string (a long generated
   * init function is the worst case — see bench/cfg).
   */
  textParts: string[];
  kind: BasicBlockData['kind'];
  /**
   * Per-statement def/use facts in execution order (#2082 M2 U1). Parallel to
   * the statements that accrued to this block — but self-describing (each
   * record carries its line): facts-only attaches (ENTRY params, catch params)
   * mean fact index ≠ text-fragment index.
   */
  statements: StatementFacts[];
}

export class CfgBuilder {
  private readonly blocks: MutableBlock[] = [];
  private readonly edges: CfgEdgeData[] = [];
  private readonly edgeKeys = new Set<string>();
  readonly entryIndex: number;
  readonly exitIndex: number;

  constructor(
    private readonly filePath: string,
    private readonly functionStartLine: number,
    private readonly functionEndLine: number,
    /** Start column of the owning function — disambiguates same-line functions
     *  in the BasicBlock ids (see {@link FunctionCfg.functionStartColumn}).
     *  Defaults to 0 for hand-built test CFGs that don't model columns. */
    private readonly functionStartColumn: number = 0,
  ) {
    this.entryIndex = this.newBlock(functionStartLine, functionStartLine, '', 'entry');
    this.exitIndex = this.newBlock(functionEndLine, functionEndLine, '', 'exit');
  }

  /** Create a block and return its index. */
  newBlock(
    startLine: number,
    endLine: number,
    text: string,
    kind: BasicBlockData['kind'] = 'normal',
    facts?: StatementFacts,
  ): number {
    this.blocks.push({
      startLine,
      endLine,
      textParts: text ? [text] : [],
      kind,
      statements: facts ? [facts] : [],
    });
    return this.blocks.length - 1;
  }

  /** Add a single edge (idempotent on from+to+kind). */
  edge(from: number, to: number, kind: CfgEdgeKind): void {
    const key = `${from}->${to}:${kind}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ from, to, kind });
  }

  /** Wire a set of dangling exits to a single target block with one kind. */
  connect(exits: readonly number[], to: number, kind: CfgEdgeKind = 'seq'): void {
    for (const from of exits) this.edge(from, to, kind);
  }

  /** Extend a block's end line as more statements accrue to it. */
  extendBlock(index: number, endLine: number, appendText?: string, facts?: StatementFacts): void {
    const b = this.blocks[index];
    if (!b) return;
    if (endLine > b.endLine) b.endLine = endLine;
    if (appendText) b.textParts.push(appendText);
    if (facts) b.statements.push(facts);
  }

  /**
   * Attach a facts-only statement record to a block WITHOUT touching its text
   * or line span (#2082 M2 U1) — bench fingerprints and CFG snapshots include
   * block text, so harvesting must never perturb it (ENTRY-block param defs
   * are the canonical use; records that must precede a walked body get their
   * own facts-only block instead, see the catch-param handling in visitTry).
   */
  attachFacts(index: number, facts: StatementFacts): void {
    const b = this.blocks[index];
    if (!b) return;
    b.statements.push(facts);
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  /** Produce the serializable CFG. Caller is responsible for having wired the
   *  function's dangling exits to {@link exitIndex} before calling.
   *
   *  Pass `bindings` (the function's binding table, possibly empty) to emit
   *  statement facts (#2082 M2 U1) — every block then carries a `statements`
   *  array. Omit it (hand-built test CFGs, pre-M2 producers) and both fields
   *  are absent, which the reaching-defs solver reports as `no-facts`. */
  finish(bindings?: readonly BindingEntry[]): FunctionCfg {
    const withFacts = bindings !== undefined;
    return {
      filePath: this.filePath,
      functionStartLine: this.functionStartLine,
      functionEndLine: this.functionEndLine,
      functionStartColumn: this.functionStartColumn,
      entryIndex: this.entryIndex,
      exitIndex: this.exitIndex,
      blocks: this.blocks.map((b, index) => ({
        index,
        startLine: b.startLine,
        endLine: b.endLine,
        text: b.textParts.join('\n'),
        kind: b.kind,
        ...(withFacts ? { statements: b.statements } : {}),
      })),
      edges: [...this.edges],
      ...(withFacts ? { bindings } : {}),
    };
  }
}

/**
 * Block indices reachable from `entryIndex` by following edges. Backs the
 * reachability property tests (R9) over hand-built and visitor-produced CFGs.
 */
export const reachableBlocks = (cfg: FunctionCfg): Set<number> => {
  const adj = new Map<number, number[]>();
  for (const e of cfg.edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const seen = new Set<number>([cfg.entryIndex]);
  const stack = [cfg.entryIndex];
  while (stack.length) {
    const n = stack.pop() as number;
    for (const next of adj.get(n) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
};
