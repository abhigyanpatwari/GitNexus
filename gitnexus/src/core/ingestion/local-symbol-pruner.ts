import type { GraphNode, NodeLabel, RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { parseTruthyEnv } from './utils/env.js';

const LOCAL_VALUE_LABELS = new Set<NodeLabel>(['Const', 'Variable', 'Static']);
const KEEP_LOCAL_VALUE_SYMBOLS_ENV = 'GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS';

export interface LocalSymbolPruneStats {
  candidateNodes: number;
  prunedNodes: number;
  keptWithSemanticEdges: number;
  skippedByEnv: boolean;
}

export const shouldKeepLocalValueSymbols = (): boolean =>
  parseTruthyEnv(process.env[KEEP_LOCAL_VALUE_SYMBOLS_ENV]);

const emptyStats = (skippedByEnv: boolean): LocalSymbolPruneStats => ({
  candidateNodes: 0,
  prunedNodes: 0,
  keptWithSemanticEdges: 0,
  skippedByEnv,
});

const isLocalValueCandidate = (node: GraphNode): boolean => {
  if (!LOCAL_VALUE_LABELS.has(node.label)) return false;
  return node.properties.scope === 'block';
};

// True when `rel` is the structural `File -> DEFINES -> candidate` edge. Callers
// guard on the candidate already being the edge target, so only the source label
// needs checking here.
const isFileDefinesEdge = (
  graph: KnowledgeGraph,
  type: RelationshipType,
  sourceId: string,
): boolean => {
  if (type !== 'DEFINES') return false;
  return graph.getNode(sourceId)?.label === 'File';
};

export const pruneLocalValueSymbols = (
  graph: KnowledgeGraph,
  options: { keepLocalValueSymbols?: boolean } = {},
): LocalSymbolPruneStats => {
  if (options.keepLocalValueSymbols ?? shouldKeepLocalValueSymbols()) {
    return emptyStats(true);
  }

  const candidateIds = new Set<string>();
  for (const node of graph.iterNodes()) {
    if (isLocalValueCandidate(node)) candidateIds.add(node.id);
  }

  if (candidateIds.size === 0) return emptyStats(false);

  const candidatesWithSemanticEdges = new Set<string>();
  // Field-wise scan (#2680): a whole-graph walk that reads only these three, so
  // materializing a relationship object per edge would be pure overhead.
  graph.forEachRelationshipFields((sourceId, targetId, type) => {
    // Any outgoing edge from a candidate is a semantic edge: the only structural
    // edge a block-local value symbol carries is the incoming File -> DEFINES, on
    // which the candidate is the target, never the source.
    if (candidateIds.has(sourceId)) {
      candidatesWithSemanticEdges.add(sourceId);
    }

    // An incoming edge is semantic unless it is the structural File -> DEFINES.
    if (candidateIds.has(targetId) && !isFileDefinesEdge(graph, type, sourceId)) {
      candidatesWithSemanticEdges.add(targetId);
    }
  });

  let prunedNodes = 0;
  for (const candidateId of candidateIds) {
    if (candidatesWithSemanticEdges.has(candidateId)) continue;
    if (graph.removeNode(candidateId)) prunedNodes++;
  }

  return {
    candidateNodes: candidateIds.size,
    prunedNodes,
    keptWithSemanticEdges: candidatesWithSemanticEdges.size,
    skippedByEnv: false,
  };
};
