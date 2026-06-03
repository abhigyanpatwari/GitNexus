// gitnexus/src/core/coverage/branch-mapper.ts
import type { KnowledgeGraph } from '../graph/types.js';
import type { BranchHitRecord } from './types.js';

export function mapBranches(
  branchHits: BranchHitRecord[],
  graph: KnowledgeGraph,
): { nodeId: string; branchId: string; hitCount: number; relatedEdges: string[] }[] {
  const nodesByFile = new Map<string, { id: string; startLine?: number; endLine?: number }[]>();
  for (const node of graph.nodes) {
    const fp = node.properties.filePath;
    if (!fp || node.properties.startLine === undefined) continue;
    if (!nodesByFile.has(fp)) nodesByFile.set(fp, []);
    nodesByFile.get(fp)!.push({
      id: node.id,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
    });
  }

  const results: { nodeId: string; branchId: string; hitCount: number; relatedEdges: string[] }[] = [];

  for (const bh of branchHits) {
    const fileNodes = nodesByFile.get(bh.filePath);
    if (!fileNodes) continue;

    const containing = fileNodes.filter(
      (n) => n.startLine !== undefined && n.endLine !== undefined &&
        n.startLine <= bh.lineNumber && bh.lineNumber <= n.endLine,
    );
    containing.sort((a, b) => ((a.endLine ?? 0) - (a.startLine ?? 0)) - ((b.endLine ?? 0) - (b.startLine ?? 0)));
    const nodeId = containing[0]?.id;
    if (!nodeId) continue;

    const relatedEdges: string[] = [];
    for (const rel of graph.relationships) {
      if (rel.sourceId === nodeId && rel.type === 'CALLS') {
        relatedEdges.push(rel.id);
      }
    }

    results.push({ nodeId, branchId: bh.branchId, hitCount: bh.hitCount, relatedEdges });
  }

  return results;
}
