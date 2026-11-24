import fs from 'node:fs';
import path from 'node:path';
import type { GraphRelationship } from 'gitnexus-shared';
import type { PipelineResult } from '../../src/types/pipeline.js';

/**
 * Materialize an in-memory fixture repo under `root`, creating parent
 * directories as needed.
 *
 * Writes in `Object.entries` order, i.e. the literal's own key order — some
 * callers depend on that (a fixture whose second file must be written after
 * the first for the property under test to mean anything), so this must stay
 * insertion-ordered rather than sorting or parallelizing the writes.
 */
export function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

export type RelEdge = {
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  sourceFilePath: string;
  targetFilePath: string;
  rel: GraphRelationship;
};

export function getRelationships(result: PipelineResult, type: string): RelEdge[] {
  const edges: RelEdge[] = [];
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === type) {
      const sourceNode = result.graph.getNode(rel.sourceId);
      const targetNode = result.graph.getNode(rel.targetId);
      edges.push({
        source: sourceNode?.properties.name ?? rel.sourceId,
        target: targetNode?.properties.name ?? rel.targetId,
        sourceLabel: sourceNode?.label ?? 'unknown',
        targetLabel: targetNode?.label ?? 'unknown',
        sourceFilePath: sourceNode?.properties.filePath ?? '',
        targetFilePath: targetNode?.properties.filePath ?? '',
        rel,
      });
    }
  }
  return edges;
}
