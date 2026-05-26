import Graph, { MultiGraph } from 'graphology';
import type { NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { EDGE_INFO, NODE_COLORS, NODE_SIZES, getCommunityColor } from './constants';
import { calculateTreeLayout } from './tree-layout';
import { calculateCirclesLayout } from './circles-layout';

export interface SigmaNodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
  nodeType: NodeLabel;
  filePath: string;
  startLine?: number;
  endLine?: number;
  hidden?: boolean;
  zIndex?: number;
  highlighted?: boolean;
  mass?: number; // ForceAtlas2 mass - higher = more repulsion
  treeAnchorX?: number;
  treeAnchorY?: number;
  treeLayer?: number;
  circlesAnchorX?: number;
  circlesAnchorY?: number;
  circlesRing?: number;
  circlesAnchorAngle?: number;
  community?: number; // Community index from Leiden algorithm
  communityColor?: string; // Color assigned by community
}

export interface SigmaEdgeAttributes {
  size: number;
  color: string;
  relationType: string;
  type?: string;
  curvature?: number;
  zIndex?: number;
  isHierarchyEdge?: boolean;
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
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> => {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const nodeCount = knowledgeGraph.nodes.length;

  // Build parent-child map from hierarchy relationships
  // CONTAINS: Folder -> File
  // DEFINES: File -> Function/Class/Interface/Method
  // parent -> children (used only for initial spatial seeding before FA2 runs)
  const parentToChildren = new Map<string, string[]>();
  // child -> parent
  const childToParent = new Map<string, string>();

  // IMPORTS is not a true structural hierarchy, but treating it as a spatial
  // seed helps FA2 converge for import-heavy codebases: files that import each
  // other start near each other, so the simulation doesn't have to close many
  // long cross-package springs from scratch.
  const spatialSeedRelations = new Set(['CONTAINS', 'DEFINES', 'IMPORTS']);

  knowledgeGraph.relationships.forEach((rel) => {
    // These relationships determine initial node positions (not graph semantics)
    if (spatialSeedRelations.has(rel.type)) {
      // source CONTAINS/DEFINES/IMPORTS target → source acts as spatial parent
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

    // Structural nodes keep their type-based color
    graph.addNode(node.id, {
      x,
      y,
      size: scaledSize,
      color: NODE_COLORS[node.label] || '#9ca3af',
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: getNodeMass(node.label, nodeCount),
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

    // Symbol nodes get colored by community if available
    const usesCommunityColor = hasCommunity && symbolTypes.has(node.label);
    const nodeColor = usesCommunityColor
      ? getCommunityColor(communityIndex!)
      : NODE_COLORS[node.label] || '#9ca3af';

    graph.addNode(nodeId, {
      x,
      y,
      size: scaledSize,
      color: nodeColor,
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: getNodeMass(node.label, nodeCount),
      community: communityIndex,
      communityColor: hasCommunity ? getCommunityColor(communityIndex!) : undefined,
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

  // Add edges with distinct colors per relationship type
  const edgeBaseSize = nodeCount > 20000 ? 0.4 : nodeCount > 5000 ? 0.6 : 1.0;

  // Edge styles - each relationship type has a DISTINCT color for clarity
  // Using varied hues so relationships are easily distinguishable
  const EDGE_STYLES: Record<string, { color: string; sizeMultiplier: number }> = {
    // STRUCTURAL - Greens (folder/file hierarchy)
    CONTAINS: { color: '#2d5a3d', sizeMultiplier: 0.4 }, // Forest green - folder contains

    // DEFINITIONS - Cyan/Teal (code definitions)
    DEFINES: { color: '#0e7490', sizeMultiplier: 0.5 }, // Cyan - file defines function/class

    // DEPENDENCIES - Blue (imports between files)
    IMPORTS: { color: '#1d4ed8', sizeMultiplier: 0.6 }, // Blue - file imports file

    // FUNCTION FLOW - Purple (call graph)
    CALLS: { color: '#7c3aed', sizeMultiplier: 0.8 }, // Violet - function calls

    // TYPE RELATIONSHIPS - Warm colors (OOP)
    EXTENDS: { color: '#c2410c', sizeMultiplier: 1.0 }, // Orange - extension
    IMPLEMENTS: { color: '#be185d', sizeMultiplier: 0.9 }, // Pink - interface implementation

    // KOTLIN/JAVA HIERARCHY — same hues as their logical equivalents so force
    // mode renders these consistently with tree/circles view.
    HAS_METHOD: { color: EDGE_INFO.DEFINES.color, sizeMultiplier: 0.4 }, // Class→Method (≈ DEFINES)
    HAS_PROPERTY: { color: EDGE_INFO.CONTAINS.color, sizeMultiplier: 0.35 }, // Class→Property (≈ CONTAINS)
  };

  // Two-pass insertion so hierarchy/DEFINES edges are drawn first (behind)
  // and cross-edges (CALLS, IMPORTS, EXTENDS) are drawn on top.
  const BACKGROUND_EDGE_TYPES = new Set(['CONTAINS', 'DEFINES', 'HAS_METHOD', 'HAS_PROPERTY']);

  const addEdge = (rel: (typeof knowledgeGraph.relationships)[number]) => {
    if (!graph.hasNode(rel.sourceId) || !graph.hasNode(rel.targetId)) return;
    if (graph.hasEdge(rel.sourceId, rel.targetId)) return;
    const style = EDGE_STYLES[rel.type] || { color: '#4a4a5a', sizeMultiplier: 0.5 };
    const curvature = 0.12 + Math.random() * 0.08;
    graph.addEdge(rel.sourceId, rel.targetId, {
      size: edgeBaseSize * style.sizeMultiplier,
      color: style.color,
      relationType: rel.type,
      type: 'curved',
      curvature,
    });
  };

  // Pass 1: background (hierarchy) edges — rendered behind
  knowledgeGraph.relationships.forEach((rel) => {
    if (BACKGROUND_EDGE_TYPES.has(rel.type)) addEdge(rel);
  });
  // Pass 2: foreground (cross) edges — rendered on top
  knowledgeGraph.relationships.forEach((rel) => {
    if (!BACKGROUND_EDGE_TYPES.has(rel.type)) addEdge(rel);
  });

  return graph;
};

export const knowledgeGraphToTreeGraphology = (
  knowledgeGraph: KnowledgeGraph,
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> => {
  const graph = new MultiGraph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const nodeCount = knowledgeGraph.nodes.length;
  const positions = calculateTreeLayout(knowledgeGraph);

  // Add nodes with tree positions
  for (const node of knowledgeGraph.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const baseSize = NODE_SIZES[node.label] || 8;
    const scaledSize = getScaledNodeSize(baseSize, nodeCount);
    const finalSize = Math.max(2, pos.size * (scaledSize / baseSize));

    graph.addNode(node.id, {
      x: pos.x,
      y: pos.y,
      size: finalSize,
      color: NODE_COLORS[node.label] || '#9ca3af',
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: 1, // No force layout in tree view
      treeAnchorX: pos.x,
      treeAnchorY: pos.y,
      treeLayer: pos.depth,
    });
  }

  // Add edges with tree-specific styling
  const edgeBaseSize = nodeCount > 20000 ? 0.4 : nodeCount > 5000 ? 0.6 : 1.0;

  const HIERARCHY_EDGE_STYLES: Record<string, { color: string; sizeMultiplier: number }> = {
    CONTAINS: { color: EDGE_INFO.CONTAINS.color, sizeMultiplier: 0.3 },
    DEFINES: { color: EDGE_INFO.DEFINES.color, sizeMultiplier: 0.3 },
    HAS_METHOD: { color: EDGE_INFO.DEFINES.color, sizeMultiplier: 0.3 }, // Kotlin Class→Method hierarchy
    HAS_PROPERTY: { color: EDGE_INFO.CONTAINS.color, sizeMultiplier: 0.25 }, // Kotlin Class→Property hierarchy
  };

  const CROSS_EDGE_STYLES: Record<string, { color: string; sizeMultiplier: number }> = {
    IMPORTS: { color: EDGE_INFO.IMPORTS.color, sizeMultiplier: 0.6 },
    CALLS: { color: EDGE_INFO.CALLS.color, sizeMultiplier: 0.8 },
    EXTENDS: { color: EDGE_INFO.EXTENDS.color, sizeMultiplier: 1.0 },
    IMPLEMENTS: { color: EDGE_INFO.IMPLEMENTS.color, sizeMultiplier: 0.9 },
  };

  // Two-pass insertion: hierarchy edges first (rendered behind), cross-edges on top.
  // Dedup by relationship ID so CONTAINS + CALLS between the same pair both survive.
  const addedTreeRelIds = new Set<string>();
  const addTreeEdge = (rel: (typeof knowledgeGraph.relationships)[number]) => {
    if (!graph.hasNode(rel.sourceId) || !graph.hasNode(rel.targetId)) return;
    if (addedTreeRelIds.has(rel.id)) return;
    addedTreeRelIds.add(rel.id);
    const isHierarchy = HIERARCHY_EDGE_STYLES[rel.type] !== undefined;
    const style = isHierarchy
      ? HIERARCHY_EDGE_STYLES[rel.type]
      : CROSS_EDGE_STYLES[rel.type] || { color: '#4a4a5a', sizeMultiplier: 0.5 };
    graph.addEdge(rel.sourceId, rel.targetId, {
      size: edgeBaseSize * style.sizeMultiplier,
      color: style.color,
      relationType: rel.type,
      type: 'curved',
      curvature: 0.1 + Math.random() * 0.1,
      isHierarchyEdge: isHierarchy,
    });
  };

  knowledgeGraph.relationships.forEach((rel) => {
    if (HIERARCHY_EDGE_STYLES[rel.type] !== undefined) addTreeEdge(rel);
  });
  knowledgeGraph.relationships.forEach((rel) => {
    if (HIERARCHY_EDGE_STYLES[rel.type] === undefined) addTreeEdge(rel);
  });

  return graph;
};

export const knowledgeGraphToCirclesGraphology = (
  knowledgeGraph: KnowledgeGraph,
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> => {
  const graph = new MultiGraph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const nodeCount = knowledgeGraph.nodes.length;
  const positions = calculateCirclesLayout(knowledgeGraph);

  for (const node of knowledgeGraph.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const baseSize = NODE_SIZES[node.label] || 8;
    const scaledSize = getScaledNodeSize(baseSize, nodeCount);
    const finalSize = Math.max(2, pos.size * (scaledSize / baseSize));

    graph.addNode(node.id, {
      x: pos.x,
      y: pos.y,
      size: finalSize,
      color: NODE_COLORS[node.label] || '#9ca3af',
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: 1,
      circlesAnchorX: pos.x,
      circlesAnchorY: pos.y,
      circlesRing: pos.ring,
      circlesAnchorAngle: pos.angle,
    });
  }

  const edgeBaseSize = nodeCount > 20000 ? 0.4 : nodeCount > 5000 ? 0.6 : 1.0;

  // Reuse the same edge style maps as tree view
  const HIERARCHY_EDGE_STYLES: Record<string, { color: string; sizeMultiplier: number }> = {
    CONTAINS: { color: EDGE_INFO.CONTAINS.color, sizeMultiplier: 0.3 },
    DEFINES: { color: EDGE_INFO.DEFINES.color, sizeMultiplier: 0.3 },
    HAS_METHOD: { color: EDGE_INFO.DEFINES.color, sizeMultiplier: 0.3 },
    HAS_PROPERTY: { color: EDGE_INFO.CONTAINS.color, sizeMultiplier: 0.25 },
  };

  const CROSS_EDGE_STYLES: Record<string, { color: string; sizeMultiplier: number }> = {
    IMPORTS: { color: EDGE_INFO.IMPORTS.color, sizeMultiplier: 0.6 },
    CALLS: { color: EDGE_INFO.CALLS.color, sizeMultiplier: 0.8 },
    EXTENDS: { color: EDGE_INFO.EXTENDS.color, sizeMultiplier: 1.0 },
    IMPLEMENTS: { color: EDGE_INFO.IMPLEMENTS.color, sizeMultiplier: 0.9 },
  };

  // Two-pass insertion: hierarchy edges first (rendered behind), cross-edges on top.
  // Dedup by relationship ID so CONTAINS + CALLS between the same pair both survive.
  const addedCirclesRelIds = new Set<string>();
  const addCirclesEdge = (rel: (typeof knowledgeGraph.relationships)[number]) => {
    if (!graph.hasNode(rel.sourceId) || !graph.hasNode(rel.targetId)) return;
    if (addedCirclesRelIds.has(rel.id)) return;
    addedCirclesRelIds.add(rel.id);
    const isHierarchy = HIERARCHY_EDGE_STYLES[rel.type] !== undefined;
    const style = isHierarchy
      ? HIERARCHY_EDGE_STYLES[rel.type]
      : CROSS_EDGE_STYLES[rel.type] || { color: '#4a4a5a', sizeMultiplier: 0.5 };
    graph.addEdge(rel.sourceId, rel.targetId, {
      size: edgeBaseSize * style.sizeMultiplier,
      color: style.color,
      relationType: rel.type,
      type: 'curved',
      curvature: 0.1 + Math.random() * 0.1,
      isHierarchyEdge: isHierarchy,
    });
  };

  knowledgeGraph.relationships.forEach((rel) => {
    if (HIERARCHY_EDGE_STYLES[rel.type] !== undefined) addCirclesEdge(rel);
  });
  knowledgeGraph.relationships.forEach((rel) => {
    if (HIERARCHY_EDGE_STYLES[rel.type] === undefined) addCirclesEdge(rel);
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
