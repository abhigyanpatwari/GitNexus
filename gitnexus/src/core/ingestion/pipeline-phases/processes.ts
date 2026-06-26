/**
 * Phase: processes
 *
 * Detects execution flows (processes) and creates Process nodes +
 * STEP_IN_PROCESS edges. Also links Route/Tool nodes to processes.
 *
 * @deps    communities, routes, tools, pruneLocalSymbols
 * @reads   graph (all nodes and relationships), communityResult, routeRegistry, toolDefs
 * @writes  graph (Process nodes, STEP_IN_PROCESS edges, ENTRY_POINT_OF edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { CommunitiesOutput } from './communities.js';
import type { RoutesOutput } from './routes.js';
import type { ToolsOutput } from './tools.js';
import type { StructureOutput } from './structure.js';
import { processProcesses, type ProcessDetectionResult } from '../process-processor.js';
import { generateId } from '../../../lib/utils.js';
import { routeNodeKey } from '../route-extractors/route-path.js';
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';
export interface ProcessesOutput {
  processResult: ProcessDetectionResult;
}

export const processesPhase: PipelinePhase<ProcessesOutput> = {
  name: 'processes',
  // `structure` supplies `totalFiles` (progress counter) without the spurious
  // structural data dependency on `parse`. `pruneLocalSymbols` is declared
  // explicitly so process extraction always reads the trimmed graph even if a
  // future option drops the intervening `mro`/`communities` phases.
  deps: ['communities', 'routes', 'tools', 'pruneLocalSymbols', 'structure'],

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
    const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

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
    );

    if (isDev) {
      logger.info(
        `🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`,
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

    // Link Route and Tool nodes to Processes
    if (routeRegistry.size > 0 || toolDefs.length > 0) {
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
      for (const [, entry] of routeRegistry) {
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
