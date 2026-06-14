/**
 * Language-agnostic CFG unit-test harness (#2195 U1).
 *
 * Generalizes the TS-bound `ts-cfg-harness` into a factory parameterized by a
 * tree-sitter grammar + a {@link CfgVisitor}, so each language's CFG visitor
 * unit tests can drive the real worker-side builder against real source —
 * never hand-built mocks. Function discovery delegates to `visitor.isFunction`,
 * so this helper carries NO language-specific node-type knowledge (the
 * no-language-naming rule the shared ingestion core follows).
 */
import Parser from 'tree-sitter';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import type { CfgVisitor, FunctionCfg, SiteRecord } from '../../src/core/ingestion/cfg/types.js';

export interface CfgHarness {
  /** Parse `code` with the configured grammar; returns the root node. */
  parse(code: string): SyntaxNode;
  /** Every function node under `root` (pre-order), per `visitor.isFunction`. */
  collectFunctions(root: SyntaxNode): SyntaxNode[];
  /** CFG of the function at `index` (default 0). Throws if absent/undefined. */
  cfgOf(code: string, index?: number): FunctionCfg;
  /** Every function's CFG, in source order. */
  cfgsOf(code: string): FunctionCfg[];
}

/**
 * Build a CFG harness for one grammar + visitor. `filePath` is the synthetic
 * path threaded into `buildFunctionCfg` (it only affects BasicBlock ids, not
 * CFG shape). The parser is created once and reused across parses.
 */
export function makeCfgHarness(
  grammar: Parser.Language,
  visitor: CfgVisitor<SyntaxNode>,
  filePath = 'fixture',
): CfgHarness {
  const parser = new Parser();
  parser.setLanguage(grammar);

  const parse = (code: string): SyntaxNode => parser.parse(code).rootNode;

  const collectFunctions = (root: SyntaxNode): SyntaxNode[] => {
    const out: SyntaxNode[] = [];
    const stack: SyntaxNode[] = [root];
    while (stack.length) {
      const n = stack.pop() as SyntaxNode;
      if (visitor.isFunction(n)) out.push(n);
      for (let i = n.namedChildCount - 1; i >= 0; i--) {
        const c = n.namedChild(i);
        if (c) stack.push(c);
      }
    }
    return out;
  };

  const cfgOf = (code: string, index = 0): FunctionCfg => {
    const fn = collectFunctions(parse(code))[index];
    if (!fn) throw new Error(`no function at index ${index}`);
    const cfg = visitor.buildFunctionCfg(fn, filePath);
    if (!cfg) throw new Error('buildFunctionCfg returned undefined');
    return cfg;
  };

  const cfgsOf = (code: string): FunctionCfg[] =>
    collectFunctions(parse(code))
      .map((fn) => visitor.buildFunctionCfg(fn, filePath))
      .filter((c): c is FunctionCfg => c !== undefined);

  return { parse, collectFunctions, cfgOf, cfgsOf };
}

// ── shared CFG-shape assertions (#2195 U8) ───────────────────────────────────
// Byte-identical helpers the per-language `*-visitor.test.ts` files each copied.
// CFG-shape only — EXIT-reachability soundness asserts against the production
// `isExitReachableFromAllBlocks` (post-dominators.ts) directly, not a re-impl.

/** The distinct edge kinds present in `cfg`. */
export const edgeKinds = (cfg: FunctionCfg): Set<string> => new Set(cfg.edges.map((e) => e.kind));

/** Index of the (first) block whose text contains `substr`. Throws if none. */
export const block = (cfg: FunctionCfg, substr: string): number => {
  const b = cfg.blocks.find((bl) => bl.text.includes(substr));
  if (!b) throw new Error(`no block containing ${JSON.stringify(substr)}`);
  return b.index;
};

/** Is `to` forward-reachable from `from` over `cfg`'s edges? */
export function reaches(cfg: FunctionCfg, from: number, to: number): boolean {
  const adj = new Map<number, number[]>();
  for (const e of cfg.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const n = stack.pop() as number;
    if (n === to) return true;
    for (const nx of adj.get(n) ?? []) if (!seen.has(nx)) (seen.add(nx), stack.push(nx));
  }
  return seen.has(to);
}

/** Is `idx` reachable from ENTRY? */
export const reachable = (cfg: FunctionCfg, idx: number): boolean =>
  reaches(cfg, cfg.entryIndex, idx);

/** Resolve a binding by name → its index in the function's binding table. */
export function bindingIdx(cfg: FunctionCfg, name: string): number {
  const i = (cfg.bindings ?? []).findIndex((b) => b.name === name);
  if (i < 0) throw new Error(`no binding ${name}`);
  return i;
}

/** Every taint `SiteRecord` harvested across the function's statements. */
export function allSites(cfg: FunctionCfg): SiteRecord[] {
  const out: SiteRecord[] = [];
  for (const b of cfg.blocks) for (const s of b.statements ?? []) out.push(...(s.sites ?? []));
  return out;
}

/** True iff at least one statement carries a (non-empty) `sites` array. */
export function hasAnySites(cfg: FunctionCfg): boolean {
  return cfg.blocks.some((b) => (b.statements ?? []).some((s) => (s.sites ?? []).length > 0));
}
