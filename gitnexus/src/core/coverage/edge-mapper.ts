// gitnexus/src/core/coverage/edge-mapper.ts
import type { KnowledgeGraph } from '../graph/types.js';
import type { EdgeTraversalRecord } from './types.js';

export function mapCoveredEdges(
  coveredNodeIds: Set<string>,
  graph: KnowledgeGraph,
  runId: string,
): EdgeTraversalRecord[] {
  const results: EdgeTraversalRecord[] = [];

  for (const rel of graph.relationships) {
    if (rel.type !== 'CALLS') continue;
    if (!coveredNodeIds.has(rel.sourceId) || !coveredNodeIds.has(rel.targetId)) continue;

    results.push({
      runId,
      edgeId: rel.id,
      sourceNodeId: rel.sourceId,
      targetNodeId: rel.targetId,
      hitCount: 1,
    });
  }

  return results;
}

export function updateEdgeTraversalCounts(
  edgeTraversals: EdgeTraversalRecord[],
  graph: KnowledgeGraph,
  runId: string,
): void {
  for (const et of edgeTraversals) {
    const rel = graph.relationships.find((r) => r.id === et.edgeId);
    if (!rel) continue;

    const prevCount = (rel as any).traverseCount ?? 0;
    const prevRuns: string[] = (rel as any).traversedInRuns ?? [];
    (rel as any).traverseCount = prevCount + et.hitCount;
    if (!prevRuns.includes(runId)) {
      (rel as any).traversedInRuns = [...prevRuns, runId];
    }
  }
}
