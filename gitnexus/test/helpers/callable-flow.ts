import { getRelationships } from './resolution-graph.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

export function callableCallSiteLines(
  result: PipelineResult,
  source: string,
  target: string,
): number[] {
  return getRelationships(result, 'CALLS')
    .filter(
      (edge) =>
        edge.source === source &&
        edge.target === target &&
        edge.rel.reason === 'callable-value-flow',
    )
    .map((edge) =>
      Number(
        edge.rel.id
          .slice(edge.rel.id.lastIndexOf(edge.rel.targetId) + edge.rel.targetId.length)
          .match(/^:(\d+):\d+(?::\d+:\d+)?$/)?.[1],
      ),
    )
    .sort((left, right) => left - right);
}

export function callsFrom(
  result: PipelineResult,
  source: string,
): Array<{ target: string; reason: string }> {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source)
    .map((edge) => ({ target: edge.target, reason: edge.rel.reason ?? '' }));
}
