import Graph from 'graphology';
import type { NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import {
  GRAPH_SURFACE_COLORS,
  NODE_SIZES,
  getAgentColor,
  getCommunityColor,
  getEdgeStyle,
  getMetricColor,
  getNodeTypeColor,
  type GraphColorMode,
} from './constants';

export type { GraphColorMode } from './constants';

export interface SigmaNodeAttributes {
  x: number;
  y: number;
  z?: number;
  size: number;
  color: string;
  baseColor?: string;
  label: string;
  nodeType: NodeLabel;
  filePath: string;
  startLine?: number;
  endLine?: number;
  hidden?: boolean;
  zIndex?: number;
  highlighted?: boolean;
  mass?: number; // ForceAtlas2 mass - higher = more repulsion
  community?: number; // Community index from Leiden algorithm
  communityColor?: string; // Color assigned by community
  dependencyCount?: number;
  healthScore?: number;
  impactScore?: number;
  runtimeScore?: number;
  agentScore?: number;
  complexityScore?: number;
  churnScore?: number;
}

export interface SigmaEdgeAttributes {
  size: number;
  color: string;
  relationType: string;
  sourceId?: string;
  targetId?: string;
  confidence?: number;
  reason?: string;
  type?: string;
  curvature?: number;
  zIndex?: number;
}

export interface GraphologyOptions {
  colorMode?: GraphColorMode;
  impactNodeIds?: Set<string>;
  agentFocusNodeIds?: Set<string>;
  citationNodeIds?: Set<string>;
  toolNodeIds?: Set<string>;
}

/**
 * Get node size scaled for graph density
 * Uses lower minimums to maintain hierarchy visibility even in huge graphs
 */
const getScaledNodeSize = (baseSize: number, nodeCount: number): number => {
  // Scale factor decreases as graph gets larger
  // But a minimum is used that preserves relative differences
  if (nodeCount > 50000) return Math.max(1, baseSize * 0.4);
  if (nodeCount > 20000) return Math.max(1.5, baseSize * 0.5);
  if (nodeCount > 5000) return Math.max(2, baseSize * 0.65);
  if (nodeCount > 1000) return Math.max(2.5, baseSize * 0.8);
  return baseSize;
};

/**
 * Get mass for node type - higher mass = more repulsion in ForceAtlas2
 * Folders get MUCH higher mass so they spread out and pull their files with them
 */
const getNodeMass = (nodeType: NodeLabel, nodeCount: number): number => {
  // Scale mass based on graph size
  const baseMassMultiplier = nodeCount > 5000 ? 2 : nodeCount > 1000 ? 1.5 : 1;

  switch (nodeType) {
    case 'Project':
      return 50 * baseMassMultiplier; // Heaviest - anchors everything
    case 'Package':
      return 30 * baseMassMultiplier; // Very heavy
    case 'Module':
      return 20 * baseMassMultiplier; // Heavy
    case 'Folder':
      return 15 * baseMassMultiplier; // Heavy - blasts folders apart!
    case 'File':
      return 3 * baseMassMultiplier; // Medium - follows folders
    case 'Class':
    case 'Interface':
      return 5 * baseMassMultiplier; // Medium-heavy
    case 'Function':
    case 'Method':
      return 2 * baseMassMultiplier; // Light
    default:
      return 1; // Default mass
  }
};

const getDependencyScore = (degree: number, maxDegree: number): number => {
  if (maxDegree <= 0) return 0;
  return Math.log1p(degree) / Math.log1p(maxDegree);
};

const getNumberProperty = (value: unknown): number => {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getRuntimeScore = (
  node: { id: string; properties: Record<string, unknown> },
  maxErrors: number,
): number => {
  const explicitRate = getNumberProperty(node.properties.errorRate ?? node.properties.error_rate);
  const errorCount = getNumberProperty(
    node.properties.errorCount ?? node.properties.errors ?? node.properties.count,
  );
  const latency = getNumberProperty(
    node.properties.p95LatencyMs ?? node.properties.durationMs ?? node.properties.latencyMs,
  );
  const errorScore = maxErrors > 0 ? Math.log1p(errorCount) / Math.log1p(maxErrors) : 0;
  const latencyScore = latency > 0 ? Math.min(1, Math.log1p(latency) / Math.log1p(2500)) : 0;
  return Math.max(Math.min(1, explicitRate), errorScore, latencyScore * 0.65);
};

const getComplexityValue = (node: { properties: Record<string, unknown> }): number => {
  const explicit = getNumberProperty(
    node.properties.complexity ??
      node.properties.cyclomaticComplexity ??
      node.properties.astComplexity,
  );
  if (explicit > 0) return explicit;
  const start = getNumberProperty(node.properties.startLine);
  const end = getNumberProperty(node.properties.endLine);
  return end > start ? end - start : 0;
};

const getChurnValue = (node: { properties: Record<string, unknown> }): number =>
  getNumberProperty(
    node.properties.churn ??
      node.properties.churnCount ??
      node.properties.recentChanges ??
      node.properties.gitChurn,
  );

const getNodeVisual = (
  baseColor: string,
  baseSize: number,
  dependencyCount: number,
  maxDependencyCount: number,
  colorMode: GraphColorMode,
  scores: {
    impactScore?: number;
    runtimeScore?: number;
    agentScore?: number;
    complexityScore?: number;
    churnScore?: number;
  } = {},
): {
  color: string;
  size: number;
  healthScore: number;
  impactScore: number;
  runtimeScore: number;
  agentScore: number;
  complexityScore: number;
  churnScore: number;
} => {
  const healthScore = getDependencyScore(dependencyCount, maxDependencyCount);
  const impactScore = scores.impactScore ?? healthScore;
  const runtimeScore = scores.runtimeScore ?? 0;
  const agentScore = scores.agentScore ?? 0;
  const complexityScore = scores.complexityScore ?? 0;
  const churnScore = scores.churnScore ?? 0;

  if (colorMode === 'health') {
    return {
      color: getMetricColor('health', healthScore),
      size: baseSize * (1 + healthScore * 0.85),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'impact') {
    return {
      color: getMetricColor('impact', impactScore),
      size: baseSize * (1 + impactScore),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'runtime') {
    return {
      color: getMetricColor('runtime', runtimeScore),
      size: baseSize * (1 + runtimeScore),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'agent') {
    return {
      color: getAgentColor(agentScore, baseColor),
      size: baseSize * (1 + agentScore * 0.9),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'complexity') {
    return {
      color: getMetricColor('complexity', complexityScore),
      size: baseSize * (1 + complexityScore * 0.7),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'churn') {
    return {
      color: getMetricColor('churn', churnScore),
      size: baseSize * (1 + churnScore * 0.7),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  return {
    color: baseColor,
    size: baseSize,
    healthScore,
    impactScore,
    runtimeScore,
    agentScore,
    complexityScore,
    churnScore,
  };
};

/**
 * Converts the KnowledgeGraph to a graphology Graph for Sigma.js
 * Folders are positioned in a wide spread, children positioned NEAR their parents
 *
 * @param knowledgeGraph - The knowledge graph to convert
 * @param communityMemberships - Optional map of nodeId -> communityIndex for community coloring
 */
export const knowledgeGraphToGraphology = (
  knowledgeGraph: KnowledgeGraph,
  communityMemberships?: Map<string, number>,
  options: GraphologyOptions = {},
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> => {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const nodeCount = knowledgeGraph.nodes.length;
  const colorMode = options.colorMode ?? 'type';
  const dependencyCounts = new Map<string, number>();
  const ignoredHealthRelationships = new Set(['MEMBER_OF', 'STEP_IN_PROCESS', 'ENTRY_POINT_OF']);

  knowledgeGraph.relationships.forEach((rel) => {
    if (ignoredHealthRelationships.has(rel.type)) return;
    dependencyCounts.set(rel.sourceId, (dependencyCounts.get(rel.sourceId) ?? 0) + 1);
    dependencyCounts.set(rel.targetId, (dependencyCounts.get(rel.targetId) ?? 0) + 1);
  });
  const maxDependencyCount = Math.max(0, ...dependencyCounts.values());
  const maxRuntimeErrors = Math.max(
    0,
    ...knowledgeGraph.nodes.map((node) =>
      getNumberProperty(
        node.properties.errorCount ?? node.properties.errors ?? node.properties.count,
      ),
    ),
  );
  const complexityValues = new Map<string, number>();
  const churnValues = new Map<string, number>();
  knowledgeGraph.nodes.forEach((node) => {
    complexityValues.set(node.id, getComplexityValue(node));
    churnValues.set(node.id, getChurnValue(node));
  });
  const maxComplexity = Math.max(0, ...complexityValues.values());
  const maxChurn = Math.max(0, ...churnValues.values());
  const scoreByMax = (value: number, maxValue: number): number =>
    maxValue > 0 ? Math.log1p(value) / Math.log1p(maxValue) : 0;
  const getAgentScore = (nodeId: string): number => {
    if (options.toolNodeIds?.has(nodeId)) return 1;
    if (options.citationNodeIds?.has(nodeId)) return 0.72;
    if (options.agentFocusNodeIds?.has(nodeId)) return 0.55;
    return 0;
  };
  const getImpactScore = (nodeId: string, dependencyCount: number): number =>
    options.impactNodeIds?.has(nodeId)
      ? 1
      : getDependencyScore(dependencyCount, maxDependencyCount) * 0.55;

  // Build parent-child map from hierarchy relationships
  // CONTAINS: Folder -> File
  // DEFINES: File -> Function/Class/Interface/Method
  // IMPORTS: File -> Import
  // parent -> children
  const parentToChildren = new Map<string, string[]>();
  // child -> parent
  const childToParent = new Map<string, string>();

  const hierarchyRelations = new Set(['CONTAINS', 'DEFINES', 'IMPORTS']);

  knowledgeGraph.relationships.forEach((rel) => {
    // These relationships represent parent-child hierarchy for positioning
    if (hierarchyRelations.has(rel.type)) {
      // source CONTAINS/DEFINES/IMPORTS target, so source is parent
      if (!parentToChildren.has(rel.sourceId)) {
        parentToChildren.set(rel.sourceId, []);
      }
      parentToChildren.get(rel.sourceId)!.push(rel.targetId);
      childToParent.set(rel.targetId, rel.sourceId);
    }
  });

  // Create node lookup
  const nodeMap = new Map(knowledgeGraph.nodes.map((n) => [n.id, n]));

  // Separate structural nodes (folders, packages) from content nodes
  const structuralTypes = new Set(['Project', 'Package', 'Module', 'Folder']);
  const structuralNodes = knowledgeGraph.nodes.filter((n) => structuralTypes.has(n.label));

  // Much wider spread for structural nodes - this is the key!
  const structuralSpread = Math.sqrt(nodeCount) * 40;
  // Small jitter for children around their parent
  const childJitter = Math.sqrt(nodeCount) * 3;

  // === CLUSTER-BASED POSITIONING ===
  // Calculate cluster centers - each cluster gets a region of the graph
  const clusterCenters = new Map<number, { x: number; y: number }>();
  if (communityMemberships && communityMemberships.size > 0) {
    // Find unique community IDs
    const communities = new Set(communityMemberships.values());
    const communityCount = communities.size;
    const clusterSpread = structuralSpread * 0.8; // Clusters spread across 80% of graph

    // Position cluster centers using golden angle for even distribution
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    let idx = 0;
    communities.forEach((communityId) => {
      const angle = idx * goldenAngle;
      const radius = clusterSpread * Math.sqrt((idx + 1) / communityCount);
      clusterCenters.set(communityId, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
      idx++;
    });
  }
  // Jitter within cluster (tighter than childJitter)
  const clusterJitter = Math.sqrt(nodeCount) * 1.5;

  // Store positions for parent lookup
  const nodePositions = new Map<string, { x: number; y: number }>();

  // Position structural nodes (folders, etc.) in a wide radial pattern FIRST
  structuralNodes.forEach((node, index) => {
    // Use golden angle for even distribution
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const angle = index * goldenAngle;
    const radius = structuralSpread * Math.sqrt((index + 1) / Math.max(structuralNodes.length, 1));

    // Add some randomness to prevent perfect patterns
    const jitter = structuralSpread * 0.15;
    const x = radius * Math.cos(angle) + (Math.random() - 0.5) * jitter;
    const y = radius * Math.sin(angle) + (Math.random() - 0.5) * jitter;

    nodePositions.set(node.id, { x, y });

    const baseSize = NODE_SIZES[node.label] || 8;
    const scaledSize = getScaledNodeSize(baseSize, nodeCount);
    const baseColor = getNodeTypeColor(node.label);
    const dependencyCount = dependencyCounts.get(node.id) ?? 0;
    const complexityScore = scoreByMax(complexityValues.get(node.id) ?? 0, maxComplexity);
    const churnScore = scoreByMax(churnValues.get(node.id) ?? 0, maxChurn);
    const visual = getNodeVisual(
      baseColor,
      scaledSize,
      dependencyCount,
      maxDependencyCount,
      colorMode,
      {
        impactScore: getImpactScore(node.id, dependencyCount),
        runtimeScore: getRuntimeScore(node, maxRuntimeErrors),
        agentScore: getAgentScore(node.id),
        complexityScore,
        churnScore,
      },
    );

    // Structural nodes keep type color by default; metric modes override it.
    graph.addNode(node.id, {
      x,
      y,
      size: visual.size,
      color: visual.color,
      baseColor,
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: getNodeMass(node.label, nodeCount),
      dependencyCount,
      healthScore: visual.healthScore,
      impactScore: visual.impactScore,
      runtimeScore: visual.runtimeScore,
      agentScore: visual.agentScore,
      complexityScore: visual.complexityScore,
      churnScore: visual.churnScore,
    });
  });

  // Process remaining nodes in HIERARCHY ORDER (parents before children)
  // Use BFS starting from structural nodes to ensure parents are positioned first
  const addNodeWithPosition = (nodeId: string) => {
    if (graph.hasNode(nodeId)) return;

    const node = nodeMap.get(nodeId);
    if (!node) return;

    let x: number, y: number;

    // Check if this is a symbol node with a community assignment
    const communityIndex = communityMemberships?.get(nodeId);
    const symbolTypes = new Set(['Function', 'Class', 'Method', 'Interface']);
    const clusterCenter = communityIndex !== undefined ? clusterCenters.get(communityIndex) : null;

    if (clusterCenter && symbolTypes.has(node.label)) {
      // CLUSTER-BASED POSITIONING: Position near cluster center with tight jitter
      x = clusterCenter.x + (Math.random() - 0.5) * clusterJitter;
      y = clusterCenter.y + (Math.random() - 0.5) * clusterJitter;
    } else {
      // HIERARCHY-BASED POSITIONING: Position near parent
      const parentId = childToParent.get(nodeId);
      const parentPos = parentId ? nodePositions.get(parentId) : null;

      if (parentPos) {
        x = parentPos.x + (Math.random() - 0.5) * childJitter;
        y = parentPos.y + (Math.random() - 0.5) * childJitter;
      } else {
        // No parent found - position randomly but still spread out
        x = (Math.random() - 0.5) * structuralSpread * 0.5;
        y = (Math.random() - 0.5) * structuralSpread * 0.5;
      }
    }

    nodePositions.set(nodeId, { x, y });

    const baseSize = NODE_SIZES[node.label] || 8;
    const scaledSize = getScaledNodeSize(baseSize, nodeCount);

    // Check if this node has a community assignment (reuse communityIndex from above)
    const hasCommunity = communityIndex !== undefined;

    // In structure mode, symbol nodes use functional-area colors. In type mode
    // they keep raw node-type colors so the legend remains truthful.
    const usesCommunityColor =
      colorMode === 'structure' && hasCommunity && symbolTypes.has(node.label);
    const nodeColor = usesCommunityColor
      ? getCommunityColor(communityIndex!)
      : getNodeTypeColor(node.label);
    const dependencyCount = dependencyCounts.get(nodeId) ?? 0;
    const complexityScore = scoreByMax(complexityValues.get(nodeId) ?? 0, maxComplexity);
    const churnScore = scoreByMax(churnValues.get(nodeId) ?? 0, maxChurn);
    const visual = getNodeVisual(
      nodeColor,
      scaledSize,
      dependencyCount,
      maxDependencyCount,
      colorMode,
      {
        impactScore: getImpactScore(nodeId, dependencyCount),
        runtimeScore: getRuntimeScore(node, maxRuntimeErrors),
        agentScore: getAgentScore(nodeId),
        complexityScore,
        churnScore,
      },
    );

    graph.addNode(nodeId, {
      x,
      y,
      size: visual.size,
      color: visual.color,
      baseColor: nodeColor,
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: getNodeMass(node.label, nodeCount),
      community: communityIndex,
      communityColor: hasCommunity ? getCommunityColor(communityIndex!) : undefined,
      dependencyCount,
      healthScore: visual.healthScore,
      impactScore: visual.impactScore,
      runtimeScore: visual.runtimeScore,
      agentScore: visual.agentScore,
      complexityScore: visual.complexityScore,
      churnScore: visual.churnScore,
    });
  };

  // BFS from structural nodes - this ensures parent is ALWAYS positioned before child
  const queue: string[] = [...structuralNodes.map((n) => n.id)];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const currentId = queue.shift()!;

    // Get children of current node and add them
    const children = parentToChildren.get(currentId) || [];
    for (const childId of children) {
      if (!visited.has(childId)) {
        visited.add(childId);
        addNodeWithPosition(childId);
        queue.push(childId); // Add to queue so its children are processed too
      }
    }
  }

  // Add any orphan nodes that weren't reached (no parent relationship)
  knowledgeGraph.nodes.forEach((node) => {
    if (!graph.hasNode(node.id)) {
      addNodeWithPosition(node.id);
    }
  });

  // Add edges using the shared relationship palette so renderers and legends agree.
  const edgeBaseSize = nodeCount > 20000 ? 0.4 : nodeCount > 5000 ? 0.6 : 1.0;

  knowledgeGraph.relationships.forEach((rel) => {
    if (graph.hasNode(rel.sourceId) && graph.hasNode(rel.targetId)) {
      if (!graph.hasEdge(rel.sourceId, rel.targetId)) {
        const style = getEdgeStyle(rel.type);
        const curvature = 0.12 + Math.random() * 0.08;

        graph.addEdge(rel.sourceId, rel.targetId, {
          size: edgeBaseSize * style.sizeMultiplier,
          color: style.color,
          relationType: rel.type,
          sourceId: rel.sourceId,
          targetId: rel.targetId,
          confidence: rel.confidence,
          reason: rel.reason,
          type: 'curved',
          curvature: curvature,
        });
      }
    }
  });

  return graph;
};

/**
 * Filter nodes by visibility - sets hidden attribute
 */
export const filterGraphByLabels = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  visibleLabels: NodeLabel[],
): void => {
  graph.forEachNode((nodeId, attributes) => {
    const isVisible = visibleLabels.includes(attributes.nodeType);
    graph.setNodeAttribute(nodeId, 'hidden', !isVisible);
  });
};

/**
 * Get all nodes within N hops of a starting node
 */
export const getNodesWithinHops = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  startNodeId: string,
  maxHops: number,
): Set<string> => {
  const visited = new Set<string>();
  const queue: { nodeId: string; depth: number }[] = [{ nodeId: startNodeId, depth: 0 }];

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    if (depth < maxHops) {
      graph.forEachNeighbor(nodeId, (neighborId) => {
        if (!visited.has(neighborId)) {
          queue.push({ nodeId: neighborId, depth: depth + 1 });
        }
      });
    }
  }

  return visited;
};

/**
 * Filter nodes by depth from selected node
 */
export const filterGraphByDepth = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  selectedNodeId: string | null,
  maxHops: number | null,
  visibleLabels: NodeLabel[],
): void => {
  if (maxHops === null) {
    filterGraphByLabels(graph, visibleLabels);
    return;
  }

  if (selectedNodeId === null || !graph.hasNode(selectedNodeId)) {
    filterGraphByLabels(graph, visibleLabels);
    return;
  }

  const nodesInRange = getNodesWithinHops(graph, selectedNodeId, maxHops);

  graph.forEachNode((nodeId, attributes) => {
    const isLabelVisible = visibleLabels.includes(attributes.nodeType);
    const isInRange = nodesInRange.has(nodeId);
    graph.setNodeAttribute(nodeId, 'hidden', !isLabelVisible || !isInRange);
  });
};
