/**
 * cfg/emit.ts (issue #2081, M1) — serialized side-channel → graph.
 *
 * Pure helper: given a file's per-function CFGs (off `ParsedFile.cfgSideChannel`,
 * produced by the worker in U3), emit one persisted `BasicBlock` node per block
 * and one `CFG` edge per edge into the {@link KnowledgeGraph}. Invoked from
 * scope-resolution (run.ts Phase 4) while the disk-backed ParsedFile store is
 * still live — the only window where the worker-built CFGs are loaded (KTD1/
 * KTD5). Default (`--pdg` off) runs never call this, so the emitted graph stays
 * byte-identical to a pre-#2081 run.
 *
 * BasicBlock id: `BasicBlock:<filePath>:<functionStartLine>:<functionStartColumn>:<blockIndex>`
 * (KTD3). The function start line+column segments disambiguate blocks across
 * multiple functions in one file — including same-line functions — since each
 * function's block indices restart at 0; blocks carry no `name` (the
 * BasicBlock table has no such column). The edge KIND
 * (`seq`/`cond-true`/…) rides in the relationship `reason` — CFG edges are
 * values of the single `CodeRelation` table's `type` column (`'CFG'`), so the
 * kind cannot be its own edge type and is queried via `reason`.
 */
import type { KnowledgeGraph } from '../../graph/types.js';
import { generateId } from '../../../lib/utils.js';
import { computeReachingDefs } from './reaching-defs.js';
import type { BindingEntry, FunctionCfg } from './types.js';

/**
 * Default per-function CFG edge cap. A pathological generated function could
 * otherwise emit an unbounded edge set; the cap bounds graph growth and is
 * overridable via `--pdg` options. `0` (in options) means no cap (unlimited
 * — see the `cap` mapping in {@link emitFileCfgs}); `undefined` means this
 * default.
 */
export const DEFAULT_MAX_CFG_EDGES_PER_FUNCTION = 5000;

/**
 * Default per-function REACHING_DEF edge cap (#2082 M2 KTD9). 4000 mirrors
 * Joern's per-method `maxNumberOfDefinitions` — the closest production prior
 * art — but truncates-and-warns instead of silently skipping the function.
 * Counts (defBlock, useBlock, binding) DEDUPED edges, not statement-level
 * facts. `0` ⇒ unlimited; `undefined` ⇒ this default.
 */
export const DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION = 4000;

/**
 * Fact-materialization headroom over the edge cap (#2082 M2 U3/F3): facts are
 * O(defs×uses) BY SPEC in merge-heavy code, and the edge cap alone bounds the
 * GRAPH, not the per-function memory spike of materializing facts before
 * dedup. {@link emitFileReachingDefs} hands `edgeCap × this` to
 * `computeReachingDefs` as `maxFacts` (unlimited when the edge cap is 0) —
 * single source of truth; the DEFAULT constant below is derived, never the
 * mechanism.
 */
export const REACHING_DEF_FACTS_PER_EDGE_CAP = 4;

/** Derived emit-path fact limit at the default edge cap (bench/doc anchor). */
export const DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION =
  REACHING_DEF_FACTS_PER_EDGE_CAP * DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION;

export interface CfgEmitResult {
  blocks: number;
  edges: number;
  /** Edges dropped because a function's edge count exceeded the cap. */
  droppedEdges: number;
  /** Number of functions that hit the cap. */
  cappedFunctions: number;
}

const basicBlockId = (
  filePath: string,
  functionStartLine: number,
  functionStartColumn: number,
  blockIndex: number,
): string => `BasicBlock:${filePath}:${functionStartLine}:${functionStartColumn}:${blockIndex}`;

/**
 * Whether an untrusted `cfgSideChannel` element is safe to feed to
 * {@link emitFileCfgs}. Deliberately NOT full FunctionCfg validation — it
 * checks exactly the fields whose corruption is SILENT given emit's
 * mechanics: {@link basicBlockId} string-templates every id-anchor value
 * (filePath, function start line/column, block index, edge endpoints) and
 * the graph's addNode/addRelationship are no-throw Map inserts. Unchecked,
 * a missing anchor field cross-wires same-`undefined`-id blocks across
 * functions (addNode is first-writer-wins), and an edge endpoint that
 * matches no block index becomes a dangling `BasicBlock:…:<n>` edge that
 * detonates much later at DB bulk-load instead of throwing here — so
 * endpoints are checked for MEMBERSHIP in the block-index set, not just
 * integer-ness. Lives in this module so the guard evolves with the id
 * templating it defends (#2099 F4; M2 fields that join the id path must
 * join this check).
 */
export const isEmitSafeCfg = (cfg: FunctionCfg | undefined | null): cfg is FunctionCfg => {
  if (
    typeof cfg?.filePath !== 'string' ||
    !Number.isInteger(cfg.functionStartLine) ||
    !Number.isInteger(cfg.functionStartColumn) ||
    !Array.isArray(cfg.blocks) ||
    !Array.isArray(cfg.edges)
  ) {
    return false;
  }
  // Contiguity (index === position), not just integer-ness: every consumer —
  // this module's id templating AND the reaching-defs solver's
  // position-indexed adjacency arrays — assumes blocks[i].index === i. A
  // membership-only check would admit a compacted channel ({index:0},{index:5})
  // whose edge 0→5 passes membership but indexes past the arrays downstream.
  for (let i = 0; i < cfg.blocks.length; i++) {
    if (cfg.blocks[i]?.index !== i) return false;
  }
  const n = cfg.blocks.length;
  // entry/exit must land on real blocks — the solver feeds entryIndex straight
  // into its RPO walk, where an out-of-range index throws and (worse than this
  // one element) costs the whole FILE's REACHING_DEF pass (tri-review P3).
  if (
    !Number.isInteger(cfg.entryIndex) ||
    cfg.entryIndex < 0 ||
    cfg.entryIndex >= n ||
    !Number.isInteger(cfg.exitIndex) ||
    cfg.exitIndex < 0 ||
    cfg.exitIndex >= n
  ) {
    return false;
  }
  return cfg.edges.every(
    (e) =>
      Number.isInteger(e?.from) &&
      Number.isInteger(e?.to) &&
      e.from >= 0 &&
      e.from < n &&
      e.to >= 0 &&
      e.to < n,
  );
};

/**
 * Whether a structurally-valid CFG's M2 statement facts are safe to feed to
 * the reaching-defs solver + REACHING_DEF id templating (#2082 U1/U4): the
 * binding table's name/declLine/declColumn template into edge ids, and
 * statement def/use indices must stay IN RANGE of the table (an escaping
 * index would fabricate `undefined`-keyed ids). Deliberately SEPARATE from
 * {@link isEmitSafeCfg}: malformed facts must cost only the function's
 * REACHING_DEF projection — degrading to M1 behavior (CFG emitted, no facts)
 * — never the BasicBlock/CFG layer itself.
 */
export const hasEmitSafeFacts = (cfg: FunctionCfg): boolean => {
  const bindings = cfg.bindings;
  if (bindings === undefined) {
    // Pre-M2 channel — statements must be absent too.
    return cfg.blocks.every((b) => b.statements === undefined);
  }
  if (!Array.isArray(bindings)) return false;
  for (const b of bindings) {
    if (
      typeof b?.name !== 'string' ||
      !Number.isInteger(b.declLine) ||
      !Number.isInteger(b.declColumn)
    ) {
      return false;
    }
  }
  const bindingCount = bindings.length;
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < bindingCount;
  for (const b of cfg.blocks) {
    const stmts = b.statements;
    if (stmts === undefined) continue;
    if (!Array.isArray(stmts)) return false;
    for (const s of stmts) {
      if (!Number.isInteger(s?.line) || !Array.isArray(s.defs) || !Array.isArray(s.uses)) {
        return false;
      }
      if (!s.defs.every(inRange) || !s.uses.every(inRange)) return false;
      if (s.mayDefs !== undefined) {
        if (!Array.isArray(s.mayDefs) || !s.mayDefs.every(inRange)) return false;
      }
    }
  }
  return true;
};

/**
 * Emit BasicBlock nodes + CFG edges for every function CFG in `cfgs`.
 *
 * `maxEdgesPerFunction` caps edges per function. On overflow we stop emitting
 * that function's remaining edges and call `onWarn` naming the dropped count —
 * no silent truncation (KTD6/R6). Block nodes are always fully emitted (their
 * count is bounded by the function's statement count); only edges are capped.
 */
export function emitFileCfgs(
  graph: KnowledgeGraph,
  cfgs: readonly FunctionCfg[],
  maxEdgesPerFunction: number = DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
  onWarn?: (message: string) => void,
): CfgEmitResult {
  const result: CfgEmitResult = { blocks: 0, edges: 0, droppedEdges: 0, cappedFunctions: 0 };
  const cap = maxEdgesPerFunction > 0 ? maxEdgesPerFunction : Infinity;

  for (const cfg of cfgs) {
    const { filePath, functionStartLine, functionStartColumn } = cfg;

    for (const b of cfg.blocks) {
      graph.addNode({
        id: basicBlockId(filePath, functionStartLine, functionStartColumn, b.index),
        label: 'BasicBlock',
        properties: {
          name: '', // BasicBlock has no name column; identified by id + span
          filePath,
          startLine: b.startLine,
          endLine: b.endLine,
          text: b.text,
        },
      });
      result.blocks++;
    }

    let emittedForFn = 0;
    for (const e of cfg.edges) {
      if (emittedForFn >= cap) {
        const dropped = cfg.edges.length - emittedForFn;
        result.droppedEdges += dropped;
        result.cappedFunctions++;
        onWarn?.(
          `[cfg] ${filePath}:${functionStartLine}: per-function CFG edge cap ` +
            `(${maxEdgesPerFunction}) reached — dropped ${dropped} of ${cfg.edges.length} edges`,
        );
        break;
      }
      const sourceId = basicBlockId(filePath, functionStartLine, functionStartColumn, e.from);
      const targetId = basicBlockId(filePath, functionStartLine, functionStartColumn, e.to);
      graph.addRelationship({
        id: generateId('CFG', `${sourceId}->${targetId}:${e.kind}`),
        type: 'CFG',
        sourceId,
        targetId,
        confidence: 1.0,
        reason: e.kind, // CfgEdgeKind (seq/cond-true/loop-back/…) — queryable
      });
      result.edges++;
      emittedForFn++;
    }
  }

  return result;
}

export interface ReachingDefEmitResult {
  /** Deduped (defBlock, useBlock, binding) edges persisted. */
  edges: number;
  /** Deduped edges dropped by the per-function edge cap. */
  droppedEdges: number;
  cappedFunctions: number;
  /** Functions whose FACT materialization hit the solver's maxFacts limit. */
  truncatedFunctions: number;
  /** Functions whose facts failed {@link hasEmitSafeFacts} (CFG kept, facts skipped). */
  malformedFactFunctions: number;
  /** Total statement-level facts the solver produced (pre-dedup telemetry). */
  facts: number;
}

/**
 * Stable identity for a binding inside edge ids (#2082 M2 KTD3/KTD9):
 * `name:declLine:declCol` for declared bindings, `name@module` for synthetic
 * ones. Distinct same-name bindings never share a key; identifier characters
 * cannot contain the id separators.
 */
const bindingKey = (b: BindingEntry): string =>
  b.synthetic ? `${b.name}@module` : `${b.name}:${b.declLine}:${b.declColumn}`;

/**
 * Compute reaching definitions per function and persist the bounded
 * REACHING_DEF projection (#2082 M2 U4).
 *
 * Facts are DEDUPED to (defBlock, useBlock, binding) before budgeting — the
 * persisted columns (`from,to,type,confidence,reason,step`; relationship ids
 * are in-memory-only, the CodeRelation table has no id column) cannot
 * distinguish finer rows, so statement-indexed ids would only manufacture
 * byte-identical duplicate rows that burn budget. Statement granularity lives
 * in the in-memory {@link computeReachingDefs} result, which the M3 taint
 * engine recomputes on demand — the budget here governs only this projection
 * and can never drop a taint fact.
 *
 * R7 (no silent truncation) covers BOTH layers: the per-function edge cap AND
 * the solver's fact-materialization limit (which can fire without the edge
 * cap ever being reached, since dedup is many-to-one) each produce one
 * unconditional `onWarn`. The edge-cap warn names the top bindings by fact
 * count — overflow is almost always one variable, which is exactly the datum
 * M3 tuning wants.
 */
export function emitFileReachingDefs(
  graph: KnowledgeGraph,
  cfgs: readonly FunctionCfg[],
  maxEdgesPerFunction: number = DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
  onWarn?: (message: string) => void,
): ReachingDefEmitResult {
  const result: ReachingDefEmitResult = {
    edges: 0,
    droppedEdges: 0,
    cappedFunctions: 0,
    truncatedFunctions: 0,
    malformedFactFunctions: 0,
    facts: 0,
  };
  const cap = maxEdgesPerFunction > 0 ? maxEdgesPerFunction : Infinity;
  const maxFacts = Number.isFinite(cap) ? (cap as number) * REACHING_DEF_FACTS_PER_EDGE_CAP : 0; // 0 ⇒ unlimited

  for (const cfg of cfgs) {
    // Graceful degradation: malformed M2 facts cost only this function's
    // REACHING_DEF projection — its BasicBlock/CFG layer was already emitted.
    if (!hasEmitSafeFacts(cfg)) {
      result.malformedFactFunctions++;
      onWarn?.(
        `[reaching-defs] ${cfg.filePath}:${cfg.functionStartLine}: malformed ` +
          `statement facts (bad binding table or out-of-range fact indices) — ` +
          `REACHING_DEF skipped for this function; its CFG is unaffected`,
      );
      continue;
    }
    const r = computeReachingDefs(cfg, { maxFacts });
    if (r.status === 'no-facts') continue;
    result.facts += r.facts.length;

    const { filePath, functionStartLine, functionStartColumn } = cfg;
    if (r.status === 'truncated') {
      result.truncatedFunctions++;
      onWarn?.(
        `[reaching-defs] ${filePath}:${functionStartLine}: fact materialization ` +
          `limit (${maxFacts}) reached — facts beyond it were not computed; ` +
          `the persisted REACHING_DEF projection for this function is sparse`,
      );
    } else if (r.status === 'overflow') {
      result.truncatedFunctions++;
      onWarn?.(
        `[reaching-defs] ${filePath}:${functionStartLine}: a basic block exceeds ` +
          `the def-key stride (≥2^21 coalesced statements — minified/generated ` +
          `code) — REACHING_DEF skipped for this function (computing any facts ` +
          `would risk wrong-block aliasing); its CFG is unaffected`,
      );
      continue;
    }

    // Dedup to (defBlock, useBlock, binding) — facts arrive sorted, so the
    // deduped order (and therefore cap truncation) is deterministic.
    const seen = new Set<string>();
    const deduped: { defBlock: number; useBlock: number; bindingIdx: number }[] = [];
    for (const f of r.facts) {
      const key = `${f.def.blockIndex}:${f.use.blockIndex}:${f.bindingIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({
        defBlock: f.def.blockIndex,
        useBlock: f.use.blockIndex,
        bindingIdx: f.bindingIdx,
      });
    }

    let emittedForFn = 0;
    for (const edge of deduped) {
      if (emittedForFn >= cap) {
        const dropped = deduped.length - emittedForFn;
        result.droppedEdges += dropped;
        result.cappedFunctions++;
        // Tallied lazily — cap overflow is the rare path; the common uncapped
        // case must not pay a per-fact counting pass.
        const factsPerBinding = new Map<number, number>();
        for (const f of r.facts) {
          factsPerBinding.set(f.bindingIdx, (factsPerBinding.get(f.bindingIdx) ?? 0) + 1);
        }
        const top = [...factsPerBinding.entries()]
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .slice(0, 2)
          .map(([idx, count]) => `${r.bindings[idx]?.name ?? `#${idx}`}(${count} facts)`)
          .join(', ');
        onWarn?.(
          `[reaching-defs] ${filePath}:${functionStartLine}: per-function ` +
            `REACHING_DEF edge cap (${maxEdgesPerFunction}) reached — dropped ` +
            `${dropped} of ${deduped.length} edges; top bindings: ${top}`,
        );
        break;
      }
      const binding = r.bindings[edge.bindingIdx];
      const sourceId = basicBlockId(
        filePath,
        functionStartLine,
        functionStartColumn,
        edge.defBlock,
      );
      const targetId = basicBlockId(
        filePath,
        functionStartLine,
        functionStartColumn,
        edge.useBlock,
      );
      graph.addRelationship({
        // Single function anchor — the two block ids share it, so templating
        // it once halves the id size (ids are in-memory-only but ~4000 of
        // them per capped function is real transient heap).
        id: generateId(
          'REACHING_DEF',
          `${filePath}:${functionStartLine}:${functionStartColumn}:` +
            `${edge.defBlock}->${edge.useBlock}:${bindingKey(binding)}`,
        ),
        type: 'REACHING_DEF',
        sourceId,
        targetId,
        confidence: 1.0,
        reason: binding.name, // plain source-level name (M0/S1 verdict) — queryable
      });
      result.edges++;
      emittedForFn++;
    }
  }

  return result;
}
