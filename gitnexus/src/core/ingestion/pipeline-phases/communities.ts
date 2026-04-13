/**
 * Phase: communities
 *
 * Detects code communities via Leiden algorithm and creates
 * Community nodes + MEMBER_OF edges.
 *
 * @deps    mro
 * @reads   graph (all nodes and relationships)
 * @writes  graph (Community nodes, MEMBER_OF edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import { processCommunities, type CommunityDetectionResult } from '../community-processor.js';

const isDev = process.env.NODE_ENV === 'development';

export interface CommunitiesOutput {
  communityResult: CommunityDetectionResult;
}

export const communitiesPhase: PipelinePhase<CommunitiesOutput> = {
  name: 'communities',
  deps: ['mro'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<CommunitiesOutput> {
    const { totalFiles } = getPhaseOutput<ParseOutput>(deps, 'parse');

    ctx.onProgress({
      phase: 'communities',
      percent: 82,
      message: 'Detecting code communities...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    const communityResult = await processCommunities(ctx.graph, (message, progress) => {
      const communityProgress = 82 + progress * 0.1;
      ctx.onProgress({
        phase: 'communities',
        percent: Math.round(communityProgress),
        message,
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
      });
    });

    if (isDev) {
      console.log(
        `🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`,
      );
    }

    communityResult.communities.forEach((comm) => {
      ctx.graph.addNode({
        id: comm.id,
        label: 'Community' as const,
        properties: {
          name: comm.label,
          filePath: '',
          heuristicLabel: comm.heuristicLabel,
          cohesion: comm.cohesion,
          symbolCount: comm.symbolCount,
        },
      });
    });

    communityResult.memberships.forEach((membership) => {
      ctx.graph.addRelationship({
        id: `${membership.nodeId}_member_of_${membership.communityId}`,
        type: 'MEMBER_OF',
        sourceId: membership.nodeId,
        targetId: membership.communityId,
        confidence: 1.0,
        reason: 'leiden-algorithm',
      });
    });

    return { communityResult };
  },
};
