// gitnexus/src/core/coverage/graph-bridge.ts
import type { KnowledgeGraph } from '../graph/types.js';
import type { CoverageRunMeta } from './types.js';

export interface GraphCoverageUpdate {
  runMeta: CoverageRunMeta;
  symbolUpdates: Map<string, { totalLines: number; coveredLines: number; ratio: number }>;
}

export function writeCoverageToGraph(update: GraphCoverageUpdate, graph: KnowledgeGraph): string {
  const runNodeId = `CoverageRun:${update.runMeta.id}`;

  graph.addNode({
    id: runNodeId,
    label: 'CoverageRun',
    properties: {
      name: update.runMeta.label ?? update.runMeta.id,
      filePath: '',
      timestamp: update.runMeta.timestamp,
      label: update.runMeta.label,
      command: update.runMeta.command,
      durationMs: update.runMeta.durationMs,
      totalExecs: update.runMeta.totalExecs,
      totalLines: 0,
      coveredLines: 0,
      coverageRatio: 0,
      runId: update.runMeta.id,
    },
  });

  let totalLines = 0;
  let totalCovered = 0;

  for (const [nodeId, coverage] of update.symbolUpdates) {
    const node = graph.getNode(nodeId);
    if (!node) continue;

    node.properties.coverageRatio = coverage.ratio;
    node.properties.lastCoveredAt = update.runMeta.timestamp;

    const relId = `COVERED_BY:${nodeId}:${runNodeId}`;
    graph.addRelationship({
      id: relId,
      sourceId: nodeId,
      targetId: runNodeId,
      type: 'COVERED_BY',
      confidence: 1.0,
      reason: 'coverage-data',
      step: 0,
    });

    totalLines += coverage.totalLines;
    totalCovered += coverage.coveredLines;
  }

  const runNode = graph.getNode(runNodeId);
  if (runNode) {
    runNode.properties.totalLines = totalLines;
    runNode.properties.coveredLines = totalCovered;
    runNode.properties.coverageRatio = totalLines > 0 ? totalCovered / totalLines : 0;
  }

  return runNodeId;
}

export function removeCoverageFromGraph(runId: string, graph: KnowledgeGraph): void {
  const runNodeId = `CoverageRun:${runId}`;

  for (const rel of [...graph.relationships]) {
    if (rel.type === 'COVERED_BY' && rel.targetId === runNodeId) {
      graph.removeRelationship(rel.id);
    }
  }

  for (const node of graph.nodes) {
    if (node.properties.coverageRatio !== undefined) {
      node.properties.coverageRatio = undefined;
      node.properties.lastCoveredAt = undefined;
    }
  }

  graph.removeNode(runNodeId);
}
