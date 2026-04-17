/**
 * Phase: mro
 *
 * Computes Method Resolution Order (MRO) and creates METHOD_OVERRIDES
 * and METHOD_IMPLEMENTS edges.
 *
 * @deps    crossFile
 * @reads   graph (all nodes and relationships)
 * @writes  graph (METHOD_OVERRIDES, METHOD_IMPLEMENTS edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { computeMRO } from '../mro-processor.js';
import { isDev } from '../utils/env.js';

export interface MROOutput {
  entries: number;
  ambiguityCount: number;
  overrideEdges: number;
  methodImplementsEdges: number;
}

export const mroPhase: PipelinePhase<MROOutput> = {
  name: 'mro',
  deps: ['crossFile', 'structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<MROOutput> {
    const { totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

    ctx.onProgress({
      phase: 'enriching',
      percent: 83,
      message: 'Computing method resolution order...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    const mroResult = computeMRO(ctx.graph);

    if (isDev && mroResult.entries.length > 0) {
      console.log(
        `🔀 MRO: ${mroResult.entries.length} classes analyzed, ${mroResult.ambiguityCount} ambiguities, ${mroResult.overrideEdges} METHOD_OVERRIDES, ${mroResult.methodImplementsEdges} METHOD_IMPLEMENTS`,
      );
    }

    return {
      entries: mroResult.entries.length,
      ambiguityCount: mroResult.ambiguityCount,
      overrideEdges: mroResult.overrideEdges,
      methodImplementsEdges: mroResult.methodImplementsEdges,
    };
  },
};
