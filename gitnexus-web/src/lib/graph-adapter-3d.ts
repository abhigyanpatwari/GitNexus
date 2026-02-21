import { KnowledgeGraph, NodeLabel } from '../core/graph/types';
import { NODE_COLORS, NODE_SIZES, getCommunityColor } from './constants';

export interface Graph3DNode {
  id: string;
  x: number;
  y: number;
  z: number;
  size: number;
  color: string;
  label: string;
  nodeType: NodeLabel;
  filePath: string;
  startLine?: number;
  endLine?: number;
  community?: number;
}

export interface Graph3DEdge {
  id: string;
  sourceId: string;
  targetId: string;
  color: string;
  relationType: string;
}

export interface Graph3DData {
  nodes: Graph3DNode[];
  edges: Graph3DEdge[];
  nodeMap: Map<string, Graph3DNode>;
}

const getScaledNodeSize3D = (baseSize: number, nodeCount: number): number => {
  if (nodeCount > 50000) return Math.max(0.3, baseSize * 0.08);
  if (nodeCount > 20000) return Math.max(0.4, baseSize * 0.1);
  if (nodeCount > 5000) return Math.max(0.5, baseSize * 0.12);
  if (nodeCount > 1000) return Math.max(0.6, baseSize * 0.15);
  return baseSize * 0.2;
};

const EDGE_COLORS_3D: Record<string, string> = {
  CONTAINS: '#2d5a3d',
  DEFINES: '#0e7490',
  IMPORTS: '#1d4ed8',
  CALLS: '#7c3aed',
  EXTENDS: '#c2410c',
  IMPLEMENTS: '#be185d',
};

/**
 * Converts a KnowledgeGraph to 3D node/edge data for PlayCanvas rendering.
 * Uses a spherical layout with community clustering.
 */
export const knowledgeGraphTo3D = (
  knowledgeGraph: KnowledgeGraph,
  communityMemberships?: Map<string, number>
): Graph3DData => {
  const nodeCount = knowledgeGraph.nodes.length;
  const nodes: Graph3DNode[] = [];
  const edges: Graph3DEdge[] = [];
  const nodeMap = new Map<string, Graph3DNode>();

  // Build parent-child map
  const childToParent = new Map<string, string>();
  const parentToChildren = new Map<string, string[]>();
  const hierarchyRelations = new Set(['CONTAINS', 'DEFINES', 'IMPORTS']);

  knowledgeGraph.relationships.forEach(rel => {
    if (hierarchyRelations.has(rel.type)) {
      if (!parentToChildren.has(rel.sourceId)) {
        parentToChildren.set(rel.sourceId, []);
      }
      parentToChildren.get(rel.sourceId)!.push(rel.targetId);
      childToParent.set(rel.targetId, rel.sourceId);
    }
  });

  const kgNodeMap = new Map(knowledgeGraph.nodes.map(n => [n.id, n]));

  // Cluster centers in 3D space
  const clusterCenters = new Map<number, { x: number; y: number; z: number }>();
  if (communityMemberships && communityMemberships.size > 0) {
    const communities = new Set(communityMemberships.values());
    const communityCount = communities.size;
    const clusterSpread = Math.sqrt(nodeCount) * 4;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    let idx = 0;
    communities.forEach(communityId => {
      const angle = idx * goldenAngle;
      const phi = Math.acos(1 - 2 * (idx + 0.5) / communityCount);
      const radius = clusterSpread * 0.8;
      clusterCenters.set(communityId, {
        x: radius * Math.sin(phi) * Math.cos(angle),
        y: radius * Math.cos(phi),
        z: radius * Math.sin(phi) * Math.sin(angle),
      });
      idx++;
    });
  }

  // Position structural nodes
  const structuralTypes = new Set(['Project', 'Package', 'Module', 'Folder']);
  const structuralNodes = knowledgeGraph.nodes.filter(n => structuralTypes.has(n.label));
  const spread = Math.sqrt(nodeCount) * 4;
  const nodePositions = new Map<string, { x: number; y: number; z: number }>();
  const processed = new Set<string>();

  // Place structural nodes using Fibonacci sphere
  structuralNodes.forEach((node, index) => {
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const angle = index * goldenAngle;
    const t = (index + 0.5) / Math.max(structuralNodes.length, 1);
    const phi = Math.acos(1 - 2 * t);
    const radius = spread * Math.sqrt(t + 0.3);
    const jitter = spread * 0.1;

    const x = radius * Math.sin(phi) * Math.cos(angle) + (Math.random() - 0.5) * jitter;
    const y = radius * Math.cos(phi) + (Math.random() - 0.5) * jitter;
    const z = radius * Math.sin(phi) * Math.sin(angle) + (Math.random() - 0.5) * jitter;

    const pos = { x, y, z };
    nodePositions.set(node.id, pos);

    const baseSize = NODE_SIZES[node.label] || 8;
    const scaledSize = getScaledNodeSize3D(baseSize, nodeCount);

    const node3d: Graph3DNode = {
      id: node.id,
      x, y, z,
      size: scaledSize,
      color: NODE_COLORS[node.label] || '#9ca3af',
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
    };
    nodes.push(node3d);
    nodeMap.set(node.id, node3d);
    processed.add(node.id);
  });

  // BFS to position remaining nodes near parents / in clusters
  const symbolTypes = new Set(['Function', 'Class', 'Method', 'Interface']);
  const childJitter = Math.sqrt(nodeCount) * 0.8;
  const clusterJitter = Math.sqrt(nodeCount) * 0.5;

  const addNode = (nodeId: string) => {
    if (processed.has(nodeId)) return;
    processed.add(nodeId);

    const node = kgNodeMap.get(nodeId);
    if (!node) return;

    let x: number, y: number, z: number;

    const communityIndex = communityMemberships?.get(nodeId);
    const clusterCenter = communityIndex !== undefined ? clusterCenters.get(communityIndex) : null;

    if (clusterCenter && symbolTypes.has(node.label)) {
      x = clusterCenter.x + (Math.random() - 0.5) * clusterJitter;
      y = clusterCenter.y + (Math.random() - 0.5) * clusterJitter;
      z = clusterCenter.z + (Math.random() - 0.5) * clusterJitter;
    } else {
      const parentId = childToParent.get(nodeId);
      const parentPos = parentId ? nodePositions.get(parentId) : null;
      if (parentPos) {
        x = parentPos.x + (Math.random() - 0.5) * childJitter;
        y = parentPos.y + (Math.random() - 0.5) * childJitter;
        z = parentPos.z + (Math.random() - 0.5) * childJitter;
      } else {
        x = (Math.random() - 0.5) * spread * 0.5;
        y = (Math.random() - 0.5) * spread * 0.5;
        z = (Math.random() - 0.5) * spread * 0.5;
      }
    }

    nodePositions.set(nodeId, { x, y, z });

    const baseSize = NODE_SIZES[node.label] || 8;
    const scaledSize = getScaledNodeSize3D(baseSize, nodeCount);

    const hasCommunity = communityIndex !== undefined;
    const usesCommunityColor = hasCommunity && symbolTypes.has(node.label);
    const nodeColor = usesCommunityColor
      ? getCommunityColor(communityIndex!)
      : NODE_COLORS[node.label] || '#9ca3af';

    const node3d: Graph3DNode = {
      id: nodeId,
      x, y, z,
      size: scaledSize,
      color: nodeColor,
      label: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      community: communityIndex,
    };
    nodes.push(node3d);
    nodeMap.set(nodeId, node3d);
  };

  // BFS from structural nodes
  const queue: string[] = [...structuralNodes.map(n => n.id)];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const children = parentToChildren.get(currentId) || [];
    for (const childId of children) {
      if (!visited.has(childId)) {
        visited.add(childId);
        addNode(childId);
        queue.push(childId);
      }
    }
  }

  // Orphan nodes
  knowledgeGraph.nodes.forEach(node => {
    if (!processed.has(node.id)) {
      addNode(node.id);
    }
  });

  // Edges
  const addedEdges = new Set<string>();
  knowledgeGraph.relationships.forEach(rel => {
    if (nodeMap.has(rel.sourceId) && nodeMap.has(rel.targetId)) {
      const edgeKey = `${rel.sourceId}->${rel.targetId}`;
      if (!addedEdges.has(edgeKey)) {
        addedEdges.add(edgeKey);
        edges.push({
          id: rel.id,
          sourceId: rel.sourceId,
          targetId: rel.targetId,
          color: EDGE_COLORS_3D[rel.type] || '#4a4a5a',
          relationType: rel.type,
        });
      }
    }
  });

  return { nodes, edges, nodeMap };
};
