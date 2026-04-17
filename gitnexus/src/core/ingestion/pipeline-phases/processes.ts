/**
 * Phase: processes
 *
 * Detects execution flows (processes) and creates Process nodes +
 * STEP_IN_PROCESS edges. Also links Route/Tool nodes to processes.
 *
 * @deps    communities, routes, tools
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
import { isDev } from '../utils/env.js';

export interface ProcessesOutput {
  processResult: ProcessDetectionResult;
}

export const processesPhase: PipelinePhase<ProcessesOutput> = {
  name: 'processes',
  // `structure` supplies `totalFiles` (progress counter) without the spurious
  // structural data dependency on `parse`.
  deps: ['communities', 'routes', 'tools', 'structure'],

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
      percent: 94,
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
        const processProgress = 94 + progress * 0.05;
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
      console.log(
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
      const routesByFile = new Map<string, string[]>();
      for (const [url, entry] of routeRegistry) {
        let list = routesByFile.get(entry.filePath);
        if (!list) {
          list = [];
          routesByFile.set(entry.filePath, list);
        }
        list.push(url);
      }
      const toolsByFile = new Map<string, string[]>();
      for (const td of toolDefs) {
        let list = toolsByFile.get(td.filePath);
        if (!list) {
          list = [];
          toolsByFile.set(td.filePath, list);
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

        const routeURLs = routesByFile.get(entryFile);
        if (routeURLs) {
          for (const routeURL of routeURLs) {
            const routeNodeId = generateId('Route', routeURL);
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
        const toolNames = toolsByFile.get(entryFile);
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
        console.log(`🔗 Linked ${linked} Route/Tool nodes to execution flows`);
      }
    }

    return { processResult };
  },
};
