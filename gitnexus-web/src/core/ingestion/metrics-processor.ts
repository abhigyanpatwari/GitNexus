/**
 * Code Complexity Metrics Processor (Web Version)
 * 
 * Calculates code complexity metrics for Function/Method nodes:
 * - Fan-In: Incoming CALLS edges
 * - Fan-Out: Outgoing CALLS edges
 * - LOC: Lines of code
 * - Instability: fanOut / (fanIn + fanOut)
 * - Complexity Rank: low/medium/high/critical (estimated from LOC + fan-out)
 */

import { KnowledgeGraph } from '../graph/types';

export type ComplexityRank = 'low' | 'medium' | 'high' | 'critical';

export interface MetricsResult {
  stats: {
    totalNodesProcessed: number;
    avgComplexity: number;
    maxComplexity: number;
    criticalCount: number;
    highCount: number;
  };
}

const COMPLEXITY_THRESHOLDS = {
  low: 5,      // 1-5
  medium: 10,  // 6-10
  high: 20,    // 11-20
  critical: Infinity, // 21+
};

/**
 * Get complexity rank from estimated complexity value
 */
const getComplexityRank = (complexity: number): ComplexityRank => {
  if (complexity <= COMPLEXITY_THRESHOLDS.low) return 'low';
  if (complexity <= COMPLEXITY_THRESHOLDS.medium) return 'medium';
  if (complexity <= COMPLEXITY_THRESHOLDS.high) return 'high';
  return 'critical';
};

/**
 * Calculate fan-in and fan-out for all nodes based on CALLS relationships
 */
const calculateCoupling = (graph: KnowledgeGraph): Map<string, { fanIn: number; fanOut: number }> => {
  const coupling = new Map<string, { fanIn: number; fanOut: number }>();
  
  // Initialize all callable nodes
  for (const node of graph.nodes) {
    if (['Function', 'Method', 'Class'].includes(node.label)) {
      coupling.set(node.id, { fanIn: 0, fanOut: 0 });
    }
  }
  
  // Count CALLS relationships
  for (const rel of graph.relationships) {
    if (rel.type === 'CALLS') {
      // Increment fan-out for source
      const sourceMetrics = coupling.get(rel.sourceId);
      if (sourceMetrics) {
        sourceMetrics.fanOut++;
      }
      
      // Increment fan-in for target
      const targetMetrics = coupling.get(rel.targetId);
      if (targetMetrics) {
        targetMetrics.fanIn++;
      }
    }
  }
  
  return coupling;
};

/**
 * Calculate instability metric: Ce / (Ca + Ce)
 * Where Ce = fan-out (efferent coupling), Ca = fan-in (afferent coupling)
 * 0 = maximally stable, 1 = maximally unstable
 */
const calculateInstability = (fanIn: number, fanOut: number): number => {
  const total = fanIn + fanOut;
  if (total === 0) return 0;
  return Math.round((fanOut / total) * 100) / 100;
};

/**
 * Process metrics for all Function/Method nodes in the graph.
 * Uses graph-only data (no AST re-parsing needed).
 */
export const processMetrics = (
  graph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void
): MetricsResult => {
  onProgress?.('Calculating coupling metrics...', 0);
  
  // Step 1: Calculate fan-in/fan-out from CALLS relationships
  const couplingMap = calculateCoupling(graph);
  
  // Step 2: Process all Function/Method nodes
  let totalComplexity = 0;
  let maxComplexity = 0;
  let criticalCount = 0;
  let highCount = 0;
  let processedCount = 0;
  
  const callableNodes: { node: typeof graph.nodes[0]; loc: number }[] = [];
  
  for (const node of graph.nodes) {
    if (!['Function', 'Method'].includes(node.label)) continue;
    
    const startLine = node.properties.startLine ?? 0;
    const endLine = node.properties.endLine ?? startLine;
    const loc = Math.max(1, endLine - startLine + 1);
    
    callableNodes.push({ node, loc });
  }
  
  const totalNodes = callableNodes.length;
  
  for (const { node, loc } of callableNodes) {
    // Get coupling metrics
    const coupling = couplingMap.get(node.id) || { fanIn: 0, fanOut: 0 };
    const instability = calculateInstability(coupling.fanIn, coupling.fanOut);
    
    // Estimate complexity from LOC + fan-out (heuristic when AST not available)
    const estimatedComplexity = Math.max(1, Math.round(loc / 10) + coupling.fanOut);
    const rank = getComplexityRank(estimatedComplexity);
    
    // Update node properties
    node.properties.cyclomaticComplexity = estimatedComplexity;
    node.properties.fanIn = coupling.fanIn;
    node.properties.fanOut = coupling.fanOut;
    node.properties.loc = loc;
    node.properties.instability = instability;
    node.properties.complexityRank = rank;
    
    // Track stats
    totalComplexity += estimatedComplexity;
    if (estimatedComplexity > maxComplexity) maxComplexity = estimatedComplexity;
    if (rank === 'critical') criticalCount++;
    if (rank === 'high') highCount++;
    
    processedCount++;
    if (processedCount % 100 === 0) {
      onProgress?.(`Processing metrics: ${processedCount}/${totalNodes} nodes`, (processedCount / totalNodes) * 100);
    }
  }
  
  onProgress?.('Metrics calculation complete!', 100);
  
  const avgComplexity = totalNodes > 0 
    ? Math.round((totalComplexity / totalNodes) * 10) / 10 
    : 0;
  
  return {
    stats: {
      totalNodesProcessed: totalNodes,
      avgComplexity,
      maxComplexity,
      criticalCount,
      highCount,
    },
  };
};
