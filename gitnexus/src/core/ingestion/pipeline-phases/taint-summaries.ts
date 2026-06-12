/**
 * Phase: taintSummaries (#2084 M4 U3/U5)
 *
 * The interprocedural taint fixpoint. Runs AFTER scope-resolution (where the
 * complete, resolved `CALLS` graph lives in `ctx.graph` and the per-function
 * summaries were harvested in-phase) and composes those summaries to find
 * source→sink flows that cross function and file boundaries.
 *
 * Opt-in: registered with `enabledWhen: (o) => o.pdg === true` (the first real
 * pdg-gated phase). A default `analyze` run never includes it, so the graph is
 * byte-identical. No always-on phase depends on it (a filtered-out dep would
 * throw in `getPhaseOutput`).
 *
 * @deps    scopeResolution, pruneLocalSymbols
 * @reads   graph (CALLS edges, Function/Method nodes), scopeResolution output
 *          (functionSummaries)
 * @writes  graph (TAINT_PATH edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ScopeResolutionOutput } from '../scope-resolution/pipeline/phase.js';
import {
  solveInterprocTaint,
  DEFAULT_MAX_INTERPROC_HOPS,
  DEFAULT_PDG_MAX_INTERPROC_FINDINGS,
  type InterprocCallEdge,
} from '../taint/interproc-solver.js';
import { emitInterprocTaint, DEFAULT_PDG_MAX_INTERPROC_EDGES } from '../taint/interproc-emit.js';
import type { FunctionSummary } from '../taint/summary-model.js';
import { logger } from '../../logger.js';

export interface TaintSummariesOutput {
  /** Function summaries fed to the fixpoint. */
  summaries: number;
  /** Cross-function findings (pre-cap). */
  findings: number;
  /** TAINT_PATH edges persisted. */
  edgesEmitted: number;
  /** Call sites whose callee did not resolve to a summary edge (diagnostics). */
  unmatchedCallSites: number;
}

const EMPTY: TaintSummariesOutput = {
  summaries: 0,
  findings: 0,
  edgesEmitted: 0,
  unmatchedCallSites: 0,
};

export const taintSummariesPhase: PipelinePhase<TaintSummariesOutput> = {
  name: 'taintSummaries',
  deps: ['scopeResolution', 'pruneLocalSymbols'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<TaintSummariesOutput> {
    const scope = getPhaseOutput<ScopeResolutionOutput>(deps, 'scopeResolution');
    const summaries = scope.functionSummaries;
    if (summaries.length === 0) return EMPTY;

    // Index summaries by function node id.
    const summaryMap = new Map<string, FunctionSummary>(summaries.map((s) => [s.fnId, s]));

    // Build the call-edge adjacency from resolved CALLS edges. The join to a
    // summary's call-arg edge is by CALLEE NAME (base-independent — see the
    // solver doc); recover it from the callee node's `name` property.
    const callEdges: InterprocCallEdge[] = [];
    for (const rel of ctx.graph.iterRelationshipsByType('CALLS')) {
      const callee = ctx.graph.getNode(rel.targetId);
      const calleeName =
        callee && typeof callee.properties.name === 'string' ? callee.properties.name : undefined;
      if (calleeName === undefined) continue;
      callEdges.push({ callerId: rel.sourceId, calleeId: rel.targetId, calleeName });
    }

    // Arm the per-run caps (#2084 review P1-3) — every other pdg layer bounds
    // its output via RepoMeta.pdg; without this the fixpoint state + TAINT_PATH
    // edges grow unbounded on a fan-in-heavy repo (OOM). `0` ⇒ unlimited
    // (preserved like the other pdg caps). The solver/emit already implement
    // deterministic truncate-and-warn — this just hands them the budgets.
    const maxFindings = ctx.options?.pdgMaxInterprocFindings ?? DEFAULT_PDG_MAX_INTERPROC_FINDINGS;
    const maxHops = ctx.options?.pdgMaxInterprocHops ?? DEFAULT_MAX_INTERPROC_HOPS;
    const maxEdges = ctx.options?.pdgMaxInterprocEdges ?? DEFAULT_PDG_MAX_INTERPROC_EDGES;

    const solved = solveInterprocTaint(summaryMap, callEdges, { maxFindings, maxHops });
    const emit = emitInterprocTaint(ctx.graph, solved.findings, { maxEdges }, (m) =>
      logger.warn(m),
    );

    // Surface drops UNCONDITIONALLY (R4 — never silently truncate the layer).
    if (solved.droppedFindings > 0 || emit.edgesDropped > 0) {
      logger.warn(
        `[taint-interproc] capped: ${solved.droppedFindings} finding(s) dropped by the ` +
          `per-run findings cap (${maxFindings}), ${emit.edgesDropped} edge(s) by the edge cap ` +
          `(${maxEdges}) — raise pdgMaxInterprocFindings/pdgMaxInterprocEdges if intentional`,
      );
    }

    if (solved.findings.length > 0 || emit.edgesEmitted > 0) {
      logger.debug(
        `[taint-interproc] ${summaries.length} summaries, ${callEdges.length} CALLS edges → ` +
          `${solved.findings.length} cross-function finding(s), ${emit.edgesEmitted} TAINT_PATH edge(s)` +
          (emit.hopsTruncated > 0 ? `, ${emit.hopsTruncated} with truncated paths` : '') +
          (solved.unmatchedCallSites > 0
            ? `, ${solved.unmatchedCallSites} unmatched call site(s)`
            : ''),
      );
    }

    return {
      summaries: summaries.length,
      findings: solved.findings.length,
      edgesEmitted: emit.edgesEmitted,
      unmatchedCallSites: solved.unmatchedCallSites,
    };
  },
};
