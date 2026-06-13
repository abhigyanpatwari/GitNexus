/**
 * Summary-harvest driver (#2084 M4 U1) — the in-phase orchestration that turns
 * per-function CFGs into call-graph-keyed {@link FunctionSummary} objects.
 *
 * Runs inside the scope-resolution pdg window (alongside `emitFileTaint`),
 * where both the live CFG side channel AND the structure-phase `Function` /
 * `Method` graph nodes are available. For each emit-safe CFG it:
 *
 * 1. resolves the CFG's source anchor `(filePath, functionStartLine)` to its
 *    graph node id, so the summary speaks the call graph's language directly —
 *    the interprocedural fixpoint then joins summaries to `CALLS` edges by node
 *    id with no fragile re-derivation;
 * 2. runs the pure {@link harvestFunctionSummary} over the same RD facts +
 *    matched sites the M3 taint pass uses;
 * 3. stamps the own-facts `version` (#2084 review P1-1: callee-version
 *    composition is RESERVED — the fixpoint does not recompute it today).
 *
 * ## The Function↔CFG join (load-bearing)
 *
 * `FunctionCfg.functionStartLine` is 1-based (the TS visitor's `row + 1`);
 * `Function`/`Method` node `startLine` is 0-based (`startPosition.row`). The
 * join therefore looks up node start line `functionStartLine - 1`
 * ({@link NODE_TO_CFG_LINE_OFFSET}). Function nodes carry no start column, so a
 * `(filePath, startLine)` collision — two functions opening on one line,
 * `{ a: () => x(), b: () => y() }` — is ambiguous: the CFG disambiguates with
 * `functionStartColumn` but the node does not, so a colliding anchor is DROPPED
 * (counted as `unresolved`) rather than risk attaching a summary to the wrong
 * function. Rare in practice; the alternative (cross-wired summaries) is unsound.
 */

import type { ParsedImport, GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../graph/types.js';
import { computeReachingDefs } from '../cfg/reaching-defs.js';
import { DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION } from '../cfg/emit.js';
import type { FunctionCfg } from '../cfg/types.js';
import { buildTaintImportIndex, matchFunctionSites } from './match.js';
import type { SourceSinkSanitizerSpec } from './source-sink-config.js';
import { harvestFunctionSummary } from './summary-harvest.js';
import { ownFactsDigest, summaryVersion, type FunctionSummary } from './summary-model.js';

/** `cfg.functionStartLine` (1-based) − this = the node's 0-based `startLine`. */
export const NODE_TO_CFG_LINE_OFFSET = 1;

/** Node labels that can own a CFG / be a `CALLS` endpoint. */
const FUNCTIONISH_LABELS = new Set(['Function', 'Method']);

/**
 * Index of functionish graph nodes by `filePath → startLine(0-based) → ids`.
 * Built ONCE per scope-resolution pass (the graph is whole-repo); reused across
 * every file's harvest.
 */
export type FunctionNodeIndex = ReadonlyMap<string, ReadonlyMap<number, readonly string[]>>;

export function buildFunctionNodeIndex(graph: KnowledgeGraph): FunctionNodeIndex {
  const index = new Map<string, Map<number, string[]>>();
  const add = (node: GraphNode): void => {
    if (!FUNCTIONISH_LABELS.has(node.label)) return;
    const filePath = node.properties.filePath;
    const startLine = node.properties.startLine;
    if (typeof filePath !== 'string' || typeof startLine !== 'number') return;
    let byLine = index.get(filePath);
    if (!byLine) {
      byLine = new Map();
      index.set(filePath, byLine);
    }
    const ids = byLine.get(startLine);
    if (ids) ids.push(node.id);
    else byLine.set(startLine, [node.id]);
  };
  for (const node of graph.iterNodes()) add(node);
  return index;
}

/** Resolve a CFG anchor to a unique functionish node id, or undefined. */
function resolveFnId(fnIndex: FunctionNodeIndex, cfg: FunctionCfg): string | undefined {
  const byLine = fnIndex.get(cfg.filePath);
  if (!byLine) return undefined;
  const ids = byLine.get(cfg.functionStartLine - NODE_TO_CFG_LINE_OFFSET);
  // Unique match only — a same-line collision is unresolvable (no node column).
  return ids && ids.length === 1 ? ids[0] : undefined;
}

export interface FileSummaryResult {
  readonly summaries: readonly FunctionSummary[];
  /** CFGs whose anchor resolved to no unique graph node (collision / missing). */
  readonly unresolved: number;
  /** CFGs whose reaching-defs were not `computed` (no summary produced). */
  readonly gaps: number;
}

/**
 * Harvest summaries for one file's emit-safe CFGs. `cfgs` MUST already be
 * `isEmitSafeCfg`-filtered (the same `wellFormed` array fed to `emitFileTaint`).
 * Pure aside from the read-only graph lookup; never throws on valid input.
 */
export function harvestFileSummaries(
  fnIndex: FunctionNodeIndex,
  cfgs: readonly FunctionCfg[],
  parsedImports: readonly ParsedImport[],
  spec: SourceSinkSanitizerSpec,
  maxFacts: number = DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION,
): FileSummaryResult {
  const importIndex = buildTaintImportIndex(parsedImports);
  const summaries: FunctionSummary[] = [];
  let unresolved = 0;
  let gaps = 0;

  for (const cfg of cfgs) {
    const fnId = resolveFnId(fnIndex, cfg);
    if (fnId === undefined) {
      unresolved++;
      continue;
    }
    const defUse = computeReachingDefs(cfg, { maxFacts });
    const matches = matchFunctionSites(cfg, spec, importIndex);
    const harvested = harvestFunctionSummary(cfg, defUse, matches);
    if (harvested.status !== 'computed') {
      gaps++;
      continue;
    }
    const facts = harvested.facts;
    // Skip functions with NO taint behaviour at all — they cannot participate
    // in any flow and would only bloat the fixpoint's working set.
    if (
      facts.paramToReturn.length === 0 &&
      facts.paramToCallArg.length === 0 &&
      facts.paramToSink.length === 0 &&
      facts.sourceToReturn.length === 0 &&
      facts.sourceToCallArg.length === 0 &&
      facts.callResults.length === 0
    ) {
      continue;
    }
    const digest = ownFactsDigest(facts);
    summaries.push({
      fnId,
      filePath: cfg.filePath,
      startLine: cfg.functionStartLine,
      ...facts,
      // Provisional own-only version; the fixpoint recomputes with callee
      // versions once the call graph is condensed.
      version: summaryVersion(digest, []),
    });
  }

  return { summaries, unresolved, gaps };
}
