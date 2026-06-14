/**
 * collectFunctionCfgs (issue #2081, M1).
 *
 * Walks a parsed file's tree-sitter tree and builds one {@link FunctionCfg} per
 * CFG-bearing function via the language's {@link CfgVisitor}. Runs IN THE PARSE
 * WORKER (where the AST lives — KTD1/KTD7); the result rides on
 * `ParsedFile.cfgSideChannel` across the worker→main boundary.
 *
 * Nested functions are enumerated independently — each gets its own CFG, and
 * appears as an opaque straight-line block in its enclosing function's CFG (the
 * visitor does not descend into nested function bodies). `maxFunctionLines`
 * bounds per-function cost: a function whose source span exceeds the cap is
 * skipped (and counted) rather than walked, so a pathological mega-function
 * cannot blow up worker time/memory. A cap of `0` means no limit.
 */
import type { SyntaxNode } from '../utils/ast-helpers.js';
import type { CfgVisitor, FunctionCfg } from './types.js';

/**
 * Default per-function source-line cap used by the worker when the `--pdg` run
 * does not specify `pdgMaxFunctionLines`. A function longer than this (almost
 * always minified/generated code) is skipped rather than walked — its CFG is
 * both expensive and low-value. Overridable via `PipelineOptions.pdgMaxFunctionLines`.
 */
export const DEFAULT_PDG_MAX_FUNCTION_LINES = 2000;

export interface CollectedCfgs {
  readonly cfgs: readonly FunctionCfg[];
  /** Functions skipped for exceeding `maxFunctionLines` (0 ⇒ none skipped). */
  readonly skipped: number;
}

/**
 * Convert a CFG built from an EXTRACTED sub-document's AST (script-relative
 * tree-sitter rows) into the enclosing file's coordinates by adding `offset` to
 * every source-line field. Needed for embedded scripts — a Vue SFC `<script>`
 * block parses at row 0 but lives at `lineOffset` in the `.vue` file, and every
 * other worker-emitted graph node is already file-relative; without this, the
 * CFG's `functionStartLine` would never join its Function/Method graph node
 * (inter-procedural taint silently resolves nothing) and BasicBlock source
 * lines would point at the wrong `.vue` line. A 0 offset returns the input
 * unchanged (the common case: `.ts`/`.js`/etc. parse at the file root), keeping
 * non-embedded languages byte-identical. Synthetic bindings keep `declLine` 0.
 */
function shiftCfgLines(cfg: FunctionCfg, offset: number): FunctionCfg {
  if (offset === 0) return cfg;
  return {
    ...cfg,
    functionStartLine: cfg.functionStartLine + offset,
    functionEndLine: cfg.functionEndLine + offset,
    blocks: cfg.blocks.map((b) => ({
      ...b,
      startLine: b.startLine + offset,
      endLine: b.endLine + offset,
      statements: b.statements?.map((s) => ({ ...s, line: s.line + offset })),
    })),
    bindings: cfg.bindings?.map((bd) =>
      bd.declLine > 0 ? { ...bd, declLine: bd.declLine + offset } : bd,
    ),
  };
}

export function collectFunctionCfgs(
  root: SyntaxNode,
  visitor: CfgVisitor<SyntaxNode>,
  filePath: string,
  maxFunctionLines = 0,
  lineOffset = 0,
): CollectedCfgs {
  const cfgs: FunctionCfg[] = [];
  let skipped = 0;
  const stack: SyntaxNode[] = [root];

  while (stack.length) {
    const node = stack.pop() as SyntaxNode;
    if (visitor.isFunction(node)) {
      const lines = node.endPosition.row - node.startPosition.row + 1;
      if (maxFunctionLines > 0 && lines > maxFunctionLines) {
        skipped++;
      } else {
        const cfg = visitor.buildFunctionCfg(node, filePath);
        if (cfg) cfgs.push(shiftCfgLines(cfg, lineOffset));
      }
    }
    // Descend regardless (a skipped mega-function may still contain small
    // nested functions that are worth a CFG of their own).
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }

  return { cfgs, skipped };
}
