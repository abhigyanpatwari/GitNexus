/**
 * Shared test helpers for language resolution integration tests.
 */
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineOptions } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import type { GraphRelationship } from '../../../src/core/graph/types.js';

export const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'lang-resolution');
export const CROSS_FILE_FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'cross-file-binding',
);

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

export function getNodesByLabel(result: PipelineResult, label: string): string[] {
  const names: string[] = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) names.push(n.properties.name);
  });
  return names.sort();
}

export function edgeSet(edges: Array<{ source: string; target: string }>): string[] {
  return edges.map((e) => `${e.source} → ${e.target}`).sort();
}

/** Get graph nodes by label with full properties (for parameterTypes assertions). */
export function getNodesByLabelFull(
  result: PipelineResult,
  label: string,
): Array<{ name: string; properties: Record<string, any> }> {
  const nodes: Array<{ name: string; properties: Record<string, any> }> = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) nodes.push({ name: n.properties.name, properties: n.properties });
  });
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

// Tests can pass { skipGraphPhases: true } as third arg for faster runs
// (skips MRO, community detection, and process extraction).
export { runPipelineFromRepo };
export type { PipelineOptions, PipelineResult };
