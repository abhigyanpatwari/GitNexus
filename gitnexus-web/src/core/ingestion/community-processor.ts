/**
 * Community Detection Processor
 * 
 * Uses the Leiden algorithm (vendored from graphology-communities-leiden) to detect
 * communities/clusters in the code graph based on CALLS relationships.
 * 
 * Communities represent groups of code that work together frequently,
 * helping agents navigate the codebase by functional area rather than file structure.
 */

import Graph from 'graphology';
import leiden from '../../vendor/leiden/index.js';
import { KnowledgeGraph, NodeLabel } from '../graph/types';

// ============================================================================
// TYPES
// ============================================================================

export interface CommunityNode {
  id: string;
  label: string;
  heuristicLabel: string;
  cohesion: number;
  symbolCount: number;
}

export interface CommunityMembership {
  nodeId: string;
  communityId: string;
}

export interface CommunityDetectionResult {
  communities: CommunityNode[];
  memberships: CommunityMembership[];
  stats: {
    totalCommunities: number;
    modularity: number;
    nodesProcessed: number;
  };
}

// ============================================================================
// COMMUNITY COLORS (for visualization)
// ============================================================================

export const COMMUNITY_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#14b8a6', // teal
  '#84cc16', // lime
];

export const getCommunityColor = (communityIndex: number): string => {
  return COMMUNITY_COLORS[communityIndex % COMMUNITY_COLORS.length];
};

// ============================================================================
// MAIN PROCESSOR
// ============================================================================

/**
 * Detect communities in the knowledge graph using Leiden algorithm
 * 
 * This runs AFTER all relationships (CALLS, IMPORTS, etc.) have been built.
 * It uses primarily CALLS edges to cluster code that works together.
 */
export const processCommunities = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void
): Promise<CommunityDetectionResult> => {
  onProgress?.('Building graph for community detection...', 0);

  // Step 1: Build a graphology graph from the knowledge graph
  // We only include symbol nodes (Function, Class, Method) and CALLS edges
  const graph = buildGraphologyGraph(knowledgeGraph);
  
  if (graph.order === 0) {
    // No nodes to cluster
    return {
      communities: [],
      memberships: [],
      stats: { totalCommunities: 0, modularity: 0, nodesProcessed: 0 }
    };
  }

  onProgress?.(`Running Leiden algorithm on ${graph.order} nodes...`, 30);

  // Step 2: Run Leiden algorithm for community detection
  const details = leiden.detailed(graph, {
    resolution: 1.0,  // Default resolution, can be tuned
    randomWalk: true,
  });

  onProgress?.(`Found ${details.count} communities...`, 60);

  // Step 3: Create community nodes with heuristic labels
  const communityNodes = createCommunityNodes(
    details.communities as Record<string, number>,
    details.count,
    graph,
    knowledgeGraph
  );

  onProgress?.('Creating membership edges...', 80);

  // Step 4: Create membership mappings
  const memberships: CommunityMembership[] = [];
  Object.entries(details.communities).forEach(([nodeId, communityNum]) => {
    memberships.push({
      nodeId,
      communityId: `comm_${communityNum}`,
    });
  });

  onProgress?.('Community detection complete!', 100);

  return {
    communities: communityNodes,
    memberships,
    stats: {
      totalCommunities: details.count,
      modularity: details.modularity,
      nodesProcessed: graph.order,
    }
  };
};

// ============================================================================
// HELPER: Build graphology graph from knowledge graph
// ============================================================================

/**
 * Build a graphology graph containing only symbol nodes and CALLS edges
 * This is what the Leiden algorithm will cluster
 */
const buildGraphologyGraph = (knowledgeGraph: KnowledgeGraph): Graph => {
  // Use undirected graph for Leiden - it looks at edge density, not direction
  const graph = new Graph({ type: 'undirected', allowSelfLoops: false });

  // Symbol types that should be clustered
  const symbolTypes = new Set<NodeLabel>(['Function', 'Class', 'Method', 'Interface']);
  
  // Add symbol nodes
  knowledgeGraph.nodes.forEach(node => {
    if (symbolTypes.has(node.label)) {
      graph.addNode(node.id, {
        name: node.properties.name,
        filePath: node.properties.filePath,
        type: node.label,
      });
    }
  });

  // Add CALLS edges (primary clustering signal)
  // We can also include EXTENDS/IMPLEMENTS for OOP clustering
  const clusteringRelTypes = new Set(['CALLS', 'EXTENDS', 'IMPLEMENTS']);
  
  knowledgeGraph.relationships.forEach(rel => {
    if (clusteringRelTypes.has(rel.type)) {
      // Only add edge if both nodes exist in our symbol graph
      // Also skip self-loops (recursive calls) - not allowed in undirected graph
      if (graph.hasNode(rel.sourceId) && graph.hasNode(rel.targetId) && rel.sourceId !== rel.targetId) {
        // Avoid duplicate edges
        if (!graph.hasEdge(rel.sourceId, rel.targetId)) {
          graph.addEdge(rel.sourceId, rel.targetId);
        }
      }
    }
  });

  return graph;
};

// ============================================================================
// HELPER: Create community nodes with heuristic labels
// ============================================================================

/**
 * Create Community nodes with auto-generated labels based on member file paths
 */
const createCommunityNodes = (
  communities: Record<string, number>,
  communityCount: number,
  graph: Graph,
  knowledgeGraph: KnowledgeGraph
): CommunityNode[] => {
  // Group node IDs by community
  const communityMembers = new Map<number, string[]>();
  
  Object.entries(communities).forEach(([nodeId, commNum]) => {
    if (!communityMembers.has(commNum)) {
      communityMembers.set(commNum, []);
    }
    communityMembers.get(commNum)!.push(nodeId);
  });

  // Build node lookup for file paths
  const nodePathMap = new Map<string, string>();
  knowledgeGraph.nodes.forEach(node => {
    if (node.properties.filePath) {
      nodePathMap.set(node.id, node.properties.filePath);
    }
  });

  // Create community nodes - SKIP SINGLETONS (isolated nodes)
  const communityNodes: CommunityNode[] = [];
  
  communityMembers.forEach((memberIds, commNum) => {
    // Skip singleton communities - they're just isolated nodes
    if (memberIds.length < 2) return;
    
    const heuristicLabel = generateHeuristicLabel(memberIds, nodePathMap, graph, commNum);
    
    communityNodes.push({
      id: `comm_${commNum}`,
      label: heuristicLabel,
      heuristicLabel,
      cohesion: calculateCohesion(memberIds, graph),
      symbolCount: memberIds.length,
    });
  });

  // Sort by size descending
  communityNodes.sort((a, b) => b.symbolCount - a.symbolCount);

  return communityNodes;
};

// ============================================================================
// HELPER: Generate heuristic label from folder patterns
// ============================================================================

/**
 * Generate a human-readable label from the most common folder name in the community
 */
const generateHeuristicLabel = (
  memberIds: string[],
  nodePathMap: Map<string, string>,
  graph: Graph,
  commNum: number
): string => {
  // Collect folder names from file paths
  const folderCounts = new Map<string, number>();
  
  memberIds.forEach(nodeId => {
    const filePath = nodePathMap.get(nodeId) || '';
    const parts = filePath.split('/').filter(Boolean);
    
    // Get the most specific folder (parent directory)
    if (parts.length >= 2) {
      const folder = parts[parts.length - 2];
      // Skip generic folder names
      if (!['src', 'lib', 'core', 'utils', 'common', 'shared', 'helpers'].includes(folder.toLowerCase())) {
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
      }
    }
  });

  // Find most common folder
  let maxCount = 0;
  let bestFolder = '';
  
  folderCounts.forEach((count, folder) => {
    if (count > maxCount) {
      maxCount = count;
      bestFolder = folder;
    }
  });

  if (bestFolder) {
    // Capitalize first letter
    return bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1);
  }

  // Fallback: use function names to detect patterns
  const names: string[] = [];
  memberIds.forEach(nodeId => {
    const name = graph.getNodeAttribute(nodeId, 'name');
    if (name) names.push(name);
  });

  // Look for common prefixes
  if (names.length > 2) {
    const commonPrefix = findCommonPrefix(names);
    if (commonPrefix.length > 2) {
      return commonPrefix.charAt(0).toUpperCase() + commonPrefix.slice(1);
    }
  }

  // Last resort: generic name with community ID for uniqueness
  return `Cluster_${commNum}`;
};

/**
 * Find common prefix among strings
 */
const findCommonPrefix = (strings: string[]): string => {
  if (strings.length === 0) return '';
  
  const sorted = strings.slice().sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  
  let i = 0;
  while (i < first.length && first[i] === last[i]) {
    i++;
  }
  
  return first.substring(0, i);
};

// ============================================================================
// HELPER: Calculate community cohesion
// ============================================================================

/**
 * Calculate cohesion score (0-1) based on internal edge density
 * Higher cohesion = more internal connections relative to size
 */
const calculateCohesion = (memberIds: string[], graph: Graph): number => {
  if (memberIds.length <= 1) return 1.0;

  const memberSet = new Set(memberIds);
  let internalEdges = 0;
  let totalEdges = 0;

  // Count internal vs total edges for community members
  memberIds.forEach(nodeId => {
    if (graph.hasNode(nodeId)) {
      graph.forEachNeighbor(nodeId, neighbor => {
        totalEdges++;
        if (memberSet.has(neighbor)) {
          internalEdges++;
        }
      });
    }
  });

  if (totalEdges === 0) return 1.0;
  return Math.min(1.0, internalEdges / totalEdges);
};
