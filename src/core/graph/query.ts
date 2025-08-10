import type { KnowledgeGraph, GraphNode, GraphRelationship } from './types.ts';

export type NodeFilter = {
  idEquals?: string | string[];
  labelIn?: Array<GraphNode['label']>;
  nameContains?: string;
  pathContains?: string;
  props?: Record<string, unknown>;
};

export type RelFilter = {
  typeIn?: Array<GraphRelationship['type']>;
  fromIdIn?: string[];
  toIdIn?: string[];
};

export type TraverseOptions = {
  depth?: number;
  direction?: 'out' | 'in' | 'both';
  relTypeIn?: Array<GraphRelationship['type']>;
  limitNodes?: number;
};

export type PathOptions = {
  relTypeIn?: Array<GraphRelationship['type']>;
  maxDepth?: number;
  maxPaths?: number;
};

export interface GraphIndex {
  nodeById: Map<string, GraphNode>;
  outAdjacency: Map<string, GraphRelationship[]>;
  inAdjacency: Map<string, GraphRelationship[]>;
}

export function indexGraph(graph: KnowledgeGraph): GraphIndex {
  const nodeById = new Map<string, GraphNode>();
  const outAdjacency = new Map<string, GraphRelationship[]>();
  const inAdjacency = new Map<string, GraphRelationship[]>();

  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }

  for (const rel of graph.relationships) {
    if (!outAdjacency.has(rel.source)) outAdjacency.set(rel.source, []);
    if (!inAdjacency.has(rel.target)) inAdjacency.set(rel.target, []);
    outAdjacency.get(rel.source)!.push(rel);
    inAdjacency.get(rel.target)!.push(rel);
  }

  return { nodeById, outAdjacency, inAdjacency };
}

export function queryNodes(graph: KnowledgeGraph, filter: NodeFilter): GraphNode[] {
  const idSet = new Set(typeof filter.idEquals === 'string' ? [filter.idEquals] : filter.idEquals || []);
  const nameNeedle = filter.nameContains?.toLowerCase();
  const pathNeedle = filter.pathContains?.toLowerCase();

  return graph.nodes.filter((node) => {
    if (idSet.size > 0 && !idSet.has(node.id)) return false;
    if (filter.labelIn && filter.labelIn.length > 0 && !filter.labelIn.includes(node.label)) return false;

    if (nameNeedle) {
      const name = String(node.properties?.name || '').toLowerCase();
      if (!name.includes(nameNeedle)) return false;
    }

    if (pathNeedle) {
      const path = String(node.properties?.path || node.properties?.filePath || '').toLowerCase();
      if (!path.includes(pathNeedle)) return false;
    }

    if (filter.props) {
      for (const [key, expected] of Object.entries(filter.props)) {
        if ((node.properties as Record<string, unknown>)?.[key] !== expected) return false;
      }
    }

    return true;
  });
}

export function queryRelationships(graph: KnowledgeGraph, filter: RelFilter): GraphRelationship[] {
  const typeSet = new Set(filter.typeIn || []);
  const fromSet = new Set(filter.fromIdIn || []);
  const toSet = new Set(filter.toIdIn || []);

  return graph.relationships.filter((rel) => {
    if (typeSet.size > 0 && !typeSet.has(rel.type)) return false;
    if (fromSet.size > 0 && !fromSet.has(rel.source)) return false;
    if (toSet.size > 0 && !toSet.has(rel.target)) return false;
    return true;
  });
}

export function neighborsOf(
  graph: KnowledgeGraph,
  seedNodeIds: string[],
  options: TraverseOptions = {}
): KnowledgeGraph {
  const { depth = 1, direction = 'both', relTypeIn, limitNodes = 500 } = options;
  const { outAdjacency, inAdjacency, nodeById } = indexGraph(graph);

  const allowedRelTypes = relTypeIn ? new Set(relTypeIn) : null;
  const visitedNodes = new Set<string>(seedNodeIds);
  const resultNodes = new Set<string>(seedNodeIds);
  const resultRels: GraphRelationship[] = [];

  let frontier = [...seedNodeIds];
  let currentDepth = 0;

  while (frontier.length > 0 && currentDepth < depth && resultNodes.size < limitNodes) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      if (direction === 'out' || direction === 'both') {
        const outRels = outAdjacency.get(nodeId) || [];
        for (const rel of outRels) {
          if (allowedRelTypes && !allowedRelTypes.has(rel.type)) continue;
          resultRels.push(rel);
          if (!visitedNodes.has(rel.target)) {
            visitedNodes.add(rel.target);
            resultNodes.add(rel.target);
            nextFrontier.push(rel.target);
            if (resultNodes.size >= limitNodes) break;
          }
        }
      }
      if (resultNodes.size >= limitNodes) break;
      if (direction === 'in' || direction === 'both') {
        const inRels = inAdjacency.get(nodeId) || [];
        for (const rel of inRels) {
          if (allowedRelTypes && !allowedRelTypes.has(rel.type)) continue;
          resultRels.push(rel);
          if (!visitedNodes.has(rel.source)) {
            visitedNodes.add(rel.source);
            resultNodes.add(rel.source);
            nextFrontier.push(rel.source);
            if (resultNodes.size >= limitNodes) break;
          }
        }
      }
      if (resultNodes.size >= limitNodes) break;
    }
    frontier = nextFrontier;
    currentDepth++;
  }

  const nodes = Array.from(resultNodes).map((id) => nodeById.get(id)!).filter(Boolean);
  const relationships = dedupeRelationships(resultRels);
  return { nodes, relationships };
}

export function pathsBetween(
  graph: KnowledgeGraph,
  fromId: string,
  toId: string,
  options: PathOptions = {}
): KnowledgeGraph {
  const { maxDepth = 6, relTypeIn, maxPaths = 3 } = options;
  const { outAdjacency, nodeById } = indexGraph(graph);
  const allowedRelTypes = relTypeIn ? new Set(relTypeIn) : null;

  const queue: Array<{ nodeId: string; path: GraphRelationship[] }> = [{ nodeId: fromId, path: [] }];
  const visited = new Set<string>([fromId]);
  const foundPaths: GraphRelationship[][] = [];

  while (queue.length > 0 && foundPaths.length < maxPaths) {
    const { nodeId, path } = queue.shift()!;
    if (path.length > maxDepth) continue;
    if (nodeId === toId) {
      foundPaths.push(path);
      continue;
    }
    const outRels = outAdjacency.get(nodeId) || [];
    for (const rel of outRels) {
      if (allowedRelTypes && !allowedRelTypes.has(rel.type)) continue;
      const nextId = rel.target;
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ nodeId: nextId, path: [...path, rel] });
      }
    }
  }

  const relSet = new Set<GraphRelationship>();
  for (const p of foundPaths) for (const r of p) relSet.add(r);
  const nodeSet = new Set<string>();
  for (const r of relSet) {
    nodeSet.add(r.source);
    nodeSet.add(r.target);
  }

  const nodes = Array.from(nodeSet).map((id) => nodeById.get(id)!).filter(Boolean);
  const relationships = dedupeRelationships(Array.from(relSet));
  return { nodes, relationships };
}

export function subgraphFromNodesAndRels(graph: KnowledgeGraph, nodeIds: string[], rels: GraphRelationship[]): KnowledgeGraph {
  const nodeIdSet = new Set(nodeIds);
  const nodes = graph.nodes.filter((n) => nodeIdSet.has(n.id));
  const relationships = dedupeRelationships(rels);
  return { nodes, relationships };
}

export function summarizeSubgraph(subgraph: KnowledgeGraph): string {
  const counts = subgraph.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.label] = (acc[n.label] || 0) + 1;
    return acc;
  }, {});
  const relCounts = subgraph.relationships.reduce<Record<string, number>>((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  parts.push(`Nodes: ${subgraph.nodes.length} (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'})`);
  parts.push(`Relationships: ${subgraph.relationships.length} (${Object.entries(relCounts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'})`);
  const examples = subgraph.nodes.slice(0, 5).map((n) => `${n.label}:${String(n.properties?.name || n.id)}`);
  if (examples.length > 0) parts.push(`Examples: ${examples.join(', ')}`);
  return parts.join('\n');
}

function dedupeRelationships(rels: GraphRelationship[]): GraphRelationship[] {
  const seen = new Set<string>();
  const out: GraphRelationship[] = [];
  for (const r of rels) {
    const key = `${r.type}|${r.source}|${r.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
} 