import { GraphNode, GraphRelationship, KnowledgeGraph } from '../core/graph/types.js';
import { CommunityDetectionResult } from '../core/ingestion/community-processor.js';
import { ProcessDetectionResult } from '../core/ingestion/process-processor.js';
import { MetricsResult } from '../core/ingestion/metrics-processor.js';

export type PipelinePhase = 'idle' | 'extracting' | 'structure' | 'parsing' | 'imports' | 'calls' | 'heritage' | 'communities' | 'processes' | 'metrics' | 'enriching' | 'complete' | 'error';

export interface PipelineProgress {
  phase: PipelinePhase;
  percent: number;
  message: string;
  detail?: string;
  stats?: {
    filesProcessed: number;
    totalFiles: number;
    nodesCreated: number;
  };
}

// Original result type (used internally in pipeline)
export interface PipelineResult {
  graph: KnowledgeGraph;
  /** Absolute path to the repo root — used for lazy file reads during LadybugDB loading */
  repoPath: string;
  /** Total files scanned (for stats) */
  totalFileCount: number;
  communityResult?: CommunityDetectionResult;
  processResult?: ProcessDetectionResult;
  metricsResult?: MetricsResult;
}

// Serializable version for Web Worker communication
// Maps and functions cannot be transferred via postMessage
export interface SerializablePipelineResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  repoPath: string;
  totalFileCount: number;
}

// Helper to convert PipelineResult to serializable format
export const serializePipelineResult = (result: PipelineResult): SerializablePipelineResult => ({
  nodes: [...result.graph.iterNodes()],
  relationships: [...result.graph.iterRelationships()],
  repoPath: result.repoPath,
  totalFileCount: result.totalFileCount,
});

// Helper to reconstruct from serializable format (used in main thread)
export const deserializePipelineResult = (
  serialized: SerializablePipelineResult,
  createGraph: () => KnowledgeGraph
): PipelineResult => {
  const graph = createGraph();
  serialized.nodes.forEach(node => graph.addNode(node));
  serialized.relationships.forEach(rel => graph.addRelationship(rel));

  return {
    graph,
    repoPath: serialized.repoPath,
    totalFileCount: serialized.totalFileCount,
  };
};

