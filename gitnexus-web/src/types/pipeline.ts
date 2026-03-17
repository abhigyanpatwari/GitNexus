import { GraphNode, GraphRelationship, KnowledgeGraph } from '../core/graph/types';
import { CommunityDetectionResult } from '../core/ingestion/community-processor';
import { ProcessDetectionResult } from '../core/ingestion/process-processor';
import { MetricsResult } from '../core/ingestion/metrics-processor';

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
  fileContents: Map<string, string>;
  communityResult?: CommunityDetectionResult;
  processResult?: ProcessDetectionResult;
  metricsResult?: MetricsResult;
}

// Serializable version for Web Worker communication
// Maps and functions cannot be transferred via postMessage
export interface SerializablePipelineResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  fileContents: Record<string, string>; // Object instead of Map
}

// Helper to convert PipelineResult to serializable format
export const serializePipelineResult = (result: PipelineResult): SerializablePipelineResult => ({
  nodes: result.graph.nodes,
  relationships: result.graph.relationships,
  fileContents: Object.fromEntries(result.fileContents),
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
    fileContents: new Map(Object.entries(serialized.fileContents)),
  };
};

