/**
 * Phase: processes
 *
 * Detects execution flows (processes) and creates Process nodes +
 * STEP_IN_PROCESS edges. Also links Route/Tool nodes to processes.
 *
 * @deps    communities, routes, tools, springAutoConfiguration,
 *          pruneLocalSymbols, structure, parse
 * @reads   graph (all nodes and relationships), communityResult, routeRegistry,
 *          toolDefs, parse's allFetchCalls + allORMQueries (R3-6 sink sites)
 * @writes  graph (Process nodes, STEP_IN_PROCESS edges, ENTRY_POINT_OF edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { CommunitiesOutput } from './communities.js';
import type { RoutesOutput } from './routes.js';
import type { ToolsOutput } from './tools.js';
import type { StructureOutput } from './structure.js';
import type { ParseOutput } from './parse.js';
import { processProcesses, type ProcessDetectionResult } from '../process-processor.js';
import { generateId } from '../../../lib/utils.js';
import { routeNodeKey } from '../route-extractors/route-path.js';
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';
export interface ProcessesOutput {
  processResult: ProcessDetectionResult;
}

/**
 * Compute the dynamic max-processes budget from the symbol count.
 *
 * Scales proportionally (symbolCount / 10) with a floor of 20.
 * Prior to #2198 this was capped at 300 via `Math.min(300, …)`,
 * silently truncating process detection on large repositories.
 */
export function computeDynamicMaxProcesses(symbolCount: number): number {
  return Math.max(20, Math.round(symbolCount / 10));
}

export const processesPhase: PipelinePhase<ProcessesOutput> = {
  name: 'processes',
  // `structure` supplies `totalFiles` (progress counter), which is why this
  // phase historically avoided depending on `parse` at all — that dependency
  // was spurious for a progress number.
  //
  // It is no longer spurious. R3-6 reads `allFetchCalls` / `allORMQueries` from
  // the parse output to learn WHERE the program reaches outward, which is what
  // lets a trace end at a sink instead of only at a leaf. That is a real data
  // dependency, so it is declared rather than reached for implicitly — and the
  // read below still fails open, so a pipeline without that output detects no
  // sinks rather than failing the phase. `pruneLocalSymbols` is declared
  // explicitly so process extraction always reads the trimmed graph even if a
  // future option drops the intervening `mro`/`communities` phases.
  deps: [
    'communities',
    'routes',
    'tools',
    'springAutoConfiguration',
    'pruneLocalSymbols',
    'structure',
    'parse',
  ],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ProcessesOutput> {
    const { totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    const { communityResult } = getPhaseOutput<CommunitiesOutput>(deps, 'communities');
    const { routeRegistry } = getPhaseOutput<RoutesOutput>(deps, 'routes');
    const { toolDefs } = getPhaseOutput<ToolsOutput>(deps, 'tools');

    ctx.onProgress({
      phase: 'processes',
      percent: 99,
      message: 'Detecting execution flows...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    let symbolCount = 0;
    ctx.graph.forEachNode((n) => {
      if (n.label !== 'File') symbolCount++;
    });
    const dynamicMaxProcesses = computeDynamicMaxProcesses(symbolCount);

    // R3-6: where the program reaches outward. Already collected by the parse
    // phase for FILE-level FETCHES/QUERIES edges; reused here at function
    // granularity so a trace can end somewhere meaningful instead of only at a
    // leaf. Absent (or an older parse output) simply yields no sinks and the
    // previous behaviour.
    //
    // Typed as `ParseOutput` rather than a locally re-declared structural shape,
    // the way every other parse consumer does it (cross-file.ts, orm.ts,
    // routes.ts, tools.ts). `getPhaseOutput` is a raw `as T` cast, so a local
    // shape does not check anything — it only severs the compile-time link, and
    // renaming `allFetchCalls` on `ParseOutput` would then still compile here and
    // silently detect zero sinks. The runtime `.filter` below is the actual
    // guard, and it stays.
    let parseOutput: ParseOutput | undefined;
    try {
      parseOutput = getPhaseOutput<ParseOutput>(deps, 'parse');
    } catch {
      // Fail open: no sinks, previous behaviour. A missing parse output is a
      // pipeline-composition question, not a reason to lose every process.
      parseOutput = undefined;
    }
    const outwardActionSites = [
      ...(parseOutput?.allFetchCalls ?? []),
      ...(parseOutput?.allORMQueries ?? []),
    ].filter((s) => typeof s?.filePath === 'string' && typeof s?.lineNumber === 'number');

    const processResult = await processProcesses(
      ctx.graph,
      communityResult.memberships,
      (message, progress) => {
        const processProgress = 99 + progress * 0.01;
        ctx.onProgress({
          phase: 'processes',
          percent: Math.round(processProgress),
          message,
          stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
        });
      },
      { maxProcesses: dynamicMaxProcesses, minSteps: 3 },
      outwardActionSites,
    );

    if (isDev) {
      logger.info(
        `🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`,
      );
    }

    // Not gated on `isDev`: this is the one line that tells a reader the process
    // list is a SAMPLE. "823 flows" presented without it reads as the complete
    // set, which is the confident-empty failure in its other direction — a
    // confident-COMPLETE one.
    //
    // But it is only a `warn` when a ceiling removed WHOLE FLOWS from the
    // report. That split is the one `ProcessTruncationStats` already documents —
    // "unexplored entry points mean whole flows are missing, while a
    // depth-capped trace means a flow is present but shorter than it really is"
    // — and it is what keeps the line worth reading. Warning on every counter
    // meant warning on every run: this phase overrides only `maxProcesses`, so
    // at the shipped defaults (`maxBranching: 4`, `maxTraceDepth: 10`,
    // per-entry trace budget 12) `calleesDropped` fires for any function with
    // five callees, `tracesDepthCapped` for any chain deeper than ten, and
    // `walksCutByBudget` for any entry point with twelve paths under it. All
    // three are true of every non-trivial repository — and none of them removes
    // an entry point or a completed flow from the list, they only bound how far
    // an already-represented region was walked. A warning that always fires is a
    // warning nobody reads, so those three go to `debug`.
    //
    // `entryPointCandidatesDropped` IS in the loud set even though it fires on
    // any repository with more than 200 candidates, because it is the only
    // ceiling that grows with the repository: `entryPointsUnexplored` and
    // `processesDropped` can only fire while `maxProcesses` (symbols / 10) is
    // small enough to bind, so gating on those two alone would go quiet on
    // exactly the large repositories where 200 of several thousand entry points
    // is the thinnest sample. The message leads with that ratio so the line
    // carries a fact rather than an alarm.
    //
    // `stats.truncation` on the RESULT is untouched and still reports all six
    // counters; this only decides which of them are loud.
    const { truncation } = processResult.stats;
    const entryPointCandidates =
      processResult.stats.entryPointsFound + truncation.entryPointCandidatesDropped;
    const flowsMissing =
      truncation.entryPointCandidatesDropped > 0 ||
      truncation.entryPointsUnexplored > 0 ||
      truncation.processesDropped > 0;
    const shape =
      `${truncation.entryPointCandidatesDropped} of ${entryPointCandidates} candidate entry point(s) never ranked in, ` +
      `${truncation.entryPointsUnexplored} ranked entry point(s) never traced, ` +
      `${truncation.processesDropped} deduplicated flow(s) dropped at maxProcesses, ` +
      `${truncation.tracesDepthCapped} trace(s) cut at maxTraceDepth, ` +
      `${truncation.calleesDropped} callee(s) skipped at maxBranching, ` +
      `${truncation.walksCutByBudget} walk(s) cut by the per-entry trace budget.`;
    if (flowsMissing) {
      logger.warn(
        { truncation },
        `[processes] ${processResult.stats.totalProcesses} flows reported, but whole flows are MISSING: ` +
          `${shape} An absent flow does NOT mean the code path does not exist.`,
      );
    } else if (truncation.truncated) {
      logger.debug(
        { truncation },
        `[processes] ${processResult.stats.totalProcesses} flows reported; every flow found is present, ` +
          `but some are shorter than the code path they describe: ${shape}`,
      );
    }

    processResult.processes.forEach((proc) => {
      ctx.graph.addNode({
        id: proc.id,
        label: 'Process' as const,
        properties: {
          name: proc.label,
          filePath: '',
          heuristicLabel: proc.heuristicLabel,
          processType: proc.processType,
          stepCount: proc.stepCount,
          communities: proc.communities,
          entryPointId: proc.entryPointId,
          terminalId: proc.terminalId,
        },
      });
    });

    processResult.steps.forEach((step) => {
      ctx.graph.addRelationship({
        id: `${step.nodeId}_step_${step.step}_${step.processId}`,
        type: 'STEP_IN_PROCESS',
        sourceId: step.nodeId,
        targetId: step.processId,
        confidence: 1.0,
        reason: 'trace-detection',
        step: step.step,
      });
    });

    // The static registry is finalized before Spring runtime enrichment. Merge
    // runtime-confirmed Route nodes from the graph after the explicit
    // springAutoConfiguration dependency has completed, so Actuator-only
    // mappings participate in the same process-linking path.
    const processRouteRegistry = new Map(routeRegistry);
    ctx.graph.forEachNode((node) => {
      if (
        node.label !== 'Route' ||
        node.properties.runtimeSource !== 'spring-actuator' ||
        node.properties.runtimeConfirmed !== true
      ) {
        return;
      }
      const url = typeof node.properties.name === 'string' ? node.properties.name : undefined;
      const filePath =
        typeof node.properties.filePath === 'string' ? node.properties.filePath : undefined;
      const method =
        typeof node.properties.method === 'string' ? node.properties.method : undefined;
      if (url === undefined || filePath === undefined) return;
      const key = routeNodeKey(method, url);
      if (!processRouteRegistry.has(key)) {
        processRouteRegistry.set(key, {
          filePath,
          source: 'spring-actuator-runtime',
          url,
          ...(method === undefined ? {} : { method }),
        });
      }
    });

    // Link Route and Tool nodes to Processes
    if (processRouteRegistry.size > 0 || toolDefs.length > 0) {
      // Two-tier route lookup, mirroring the tool tables 10 lines below.
      // Routes whose handler resolved key by `handlerSymbolId` (read from
      // the Route node's graph properties — routes.ts stamps it there) and
      // link ONLY to the process whose entryPoint matches; routes without a
      // resolved handler fall back to a per-file bucket so we still attach
      // the Route node to a same-file process (best-effort).
      //
      // Pre-#2289-review-P2 this was a single per-file bucket: every verb
      // on a file's controller was linked to every process in that file,
      // cross-wiring same-file `GET /items` and `POST /items` to each
      // other's handler processes. The per-verb `handlerSymbolId` the
      // routes phase stamps on the Route node was never consulted.
      const routesByHandlerId = new Map<string, string[]>();
      const routesWithoutHandlerByFile = new Map<string, string[]>();
      for (const [, entry] of processRouteRegistry) {
        // Push the Route node identity (`routeNodeKey`), not the bare URL, so the
        // ENTRY_POINT_OF edge targets the same node id the routes phase created
        // (#2289: a same-URL GET/POST pair is two distinct Route nodes).
        const routeKey = routeNodeKey(entry.method, entry.url);
        // Source of truth for handlerSymbolId is the Route node in the
        // graph (routes.ts populates it from `routeHandlerSymbols`); the
        // routes phase runs before processes (see `deps`), so the node is
        // always present here.
        const routeNode = ctx.graph.getNode(generateId('Route', routeKey));
        const handlerSymbolId = routeNode?.properties.handlerSymbolId as string | undefined;
        const targetMap = handlerSymbolId ? routesByHandlerId : routesWithoutHandlerByFile;
        const bucketKey = handlerSymbolId ?? entry.filePath;
        let list = targetMap.get(bucketKey);
        if (!list) {
          list = [];
          targetMap.set(bucketKey, list);
        }
        list.push(routeKey);
      }
      const toolsByHandlerId = new Map<string, string[]>();
      const toolsWithoutHandlerByFile = new Map<string, string[]>();
      for (const td of toolDefs) {
        const key = td.handlerNodeId ?? td.filePath;
        const targetMap = td.handlerNodeId ? toolsByHandlerId : toolsWithoutHandlerByFile;
        let list = targetMap.get(key);
        if (!list) {
          list = [];
          targetMap.set(key, list);
        }
        list.push(td.name);
      }

      let linked = 0;
      for (const proc of processResult.processes) {
        if (!proc.entryPointId) continue;
        const entryNode = ctx.graph.getNode(proc.entryPointId);
        if (!entryNode) continue;
        const entryFile = entryNode.properties.filePath;
        if (!entryFile) continue;

        const exactRouteKeys = routesByHandlerId.get(proc.entryPointId);
        const fallbackRouteKeys = routesWithoutHandlerByFile.get(entryFile);
        const routeKeys = exactRouteKeys ?? fallbackRouteKeys;
        if (routeKeys) {
          for (const routeKey of routeKeys) {
            const routeNodeId = generateId('Route', routeKey);
            ctx.graph.addRelationship({
              id: generateId('ENTRY_POINT_OF', `${routeNodeId}->${proc.id}`),
              sourceId: routeNodeId,
              targetId: proc.id,
              type: 'ENTRY_POINT_OF',
              confidence: 0.85,
              reason: 'route-handler-entry-point',
            });
            linked++;
          }
        }
        const exactToolNames = toolsByHandlerId.get(proc.entryPointId);
        const fallbackToolNames = toolsWithoutHandlerByFile.get(entryFile);
        const toolNames = exactToolNames ?? fallbackToolNames;
        if (toolNames) {
          for (const toolName of toolNames) {
            const toolNodeId = generateId('Tool', toolName);
            ctx.graph.addRelationship({
              id: generateId('ENTRY_POINT_OF', `${toolNodeId}->${proc.id}`),
              sourceId: toolNodeId,
              targetId: proc.id,
              type: 'ENTRY_POINT_OF',
              confidence: 0.85,
              reason: 'tool-handler-entry-point',
            });
            linked++;
          }
        }
      }
      if (isDev && linked > 0) {
        logger.info(`🔗 Linked ${linked} Route/Tool nodes to execution flows`);
      }
    }

    return { processResult };
  },
};
