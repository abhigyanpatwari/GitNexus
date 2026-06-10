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
import type { FunctionCfg } from './types.js';

/**
 * Default per-function CFG edge cap. A pathological generated function could
 * otherwise emit an unbounded edge set; the cap bounds graph growth and is
 * overridable via `--pdg` options. `0` (in options) means no cap (unlimited
 * — see the `cap` mapping in {@link emitFileCfgs}); `undefined` means this
 * default.
 */
export const DEFAULT_MAX_CFG_EDGES_PER_FUNCTION = 5000;

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
  const blockIndices = new Set<number>();
  for (const b of cfg.blocks) {
    if (!Number.isInteger(b?.index)) return false;
    blockIndices.add(b.index);
  }
  return cfg.edges.every((e) => blockIndices.has(e?.from) && blockIndices.has(e?.to));
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
