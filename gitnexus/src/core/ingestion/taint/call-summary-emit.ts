/**
 * Call-summary emission (PDG FU-C, U-C3) — materialise `CALL_SUMMARY`.
 *
 * Persists each per-callee {@link CallSummary} as ONE `CALL_SUMMARY` self-loop
 * edge on the callee Function/Method/Constructor node, with the param→return
 * ASCENT bitset encoded in `reason` via the SHARED {@link call-summary-codec}
 * (never a second hand-rolled wire format). A later consumer phase decodes it to
 * ascend a callee's return effect into the caller continuation.
 *
 * The self-loop shape matches the schema (Function→Function / Method→Method /
 * Constructor→Constructor pairs already exist from the M0 TAINT_PATH work — zero
 * new schema pairs). Like `TAINT_PATH`/`TAINTED`, `CALL_SUMMARY` stays OUT of
 * `VALID_RELATION_TYPES` and the web schema — it is an internal PDG-engine edge.
 *
 * Boundedness mirrors the M4 interproc emit driver: dedup by the deterministic
 * edge id, an optional per-run cap, and unconditional truncate-and-warn.
 */

import type { KnowledgeGraph } from '../../graph/types.js';
import { encodeCallSummary } from './call-summary-codec.js';
import type { CallSummary } from './call-summary-model.js';

/** Confidence stamped on `CALL_SUMMARY` edges. A summary is a context-
 *  insensitive whole-parameter abstraction — a coarser signal than a resolved
 *  `CALLS` edge, so kept below 1.0 (mirrors the interproc TAINT_PATH posture). */
export const CALL_SUMMARY_CONFIDENCE = 0.6;

/** Default per-run cap on emitted `CALL_SUMMARY` edges. `0` ⇒ unlimited. */
export const DEFAULT_PDG_MAX_CALL_SUMMARY_EDGES = 0;

export interface CallSummaryEmitLimits {
  /** Max `CALL_SUMMARY` edges per run (post-dedup). `undefined`/0 ⇒ unlimited. */
  readonly maxEdges?: number;
}

export interface CallSummaryEmitResult {
  /** CALL_SUMMARY edges persisted. */
  edgesEmitted: number;
  /** Summaries dropped by the per-run cap. */
  edgesDropped: number;
  /** Summaries skipped because the callee node was missing from the graph. */
  skippedMissingEndpoint: number;
}

/**
 * Persist per-callee summaries as `CALL_SUMMARY` self-loop edges. `summaries` is
 * assumed deterministically ordered (the harvest sorts `returnFlowParams`).
 * Never throws on valid input.
 */
export function emitCallSummaries(
  graph: KnowledgeGraph,
  summaries: readonly CallSummary[],
  limits?: CallSummaryEmitLimits,
  onWarn?: (message: string) => void,
): CallSummaryEmitResult {
  const result: CallSummaryEmitResult = {
    edgesEmitted: 0,
    edgesDropped: 0,
    skippedMissingEndpoint: 0,
  };
  const maxEdges = limits?.maxEdges && limits.maxEdges > 0 ? limits.maxEdges : Infinity;
  const seen = new Set<string>();

  for (const summary of summaries) {
    if (result.edgesEmitted >= maxEdges) {
      result.edgesDropped++;
      continue;
    }
    const node = graph.getNode(summary.fnId);
    if (!node) {
      result.skippedMissingEndpoint++;
      continue;
    }
    // One self-loop edge per callee; dedup by the callee id (the harvest already
    // produces at most one summary per resolved fnId, but a same-line anchor
    // could in principle map two CFGs to one id — the Set keeps it idempotent).
    const id = `rel:CALL_SUMMARY:${summary.fnId}`;
    if (seen.has(id)) continue;
    seen.add(id);

    graph.addRelationship({
      id,
      sourceId: summary.fnId,
      targetId: summary.fnId,
      type: 'CALL_SUMMARY',
      confidence: CALL_SUMMARY_CONFIDENCE,
      reason: encodeCallSummary(summary.returnFlowParams),
    });
    result.edgesEmitted++;
  }

  if (result.edgesDropped > 0) {
    onWarn?.(
      `[call-summary] ${result.edgesDropped} CALL_SUMMARY edge(s) dropped by the ` +
        `per-run cap (${maxEdges})`,
    );
  }
  return result;
}
