import type { GraphNode, GraphRelationship, RelationshipType } from 'gitnexus-shared';
import { KnowledgeGraph } from './types.js';

/** Fresh empty iterator per call — `[].values()` returns a new
 *  exhausted iterator each invocation, so empty-type lookups don't
 *  share a single already-exhausted iterator across callers. */
function emptyRelIter(): IterableIterator<GraphRelationship> {
  return ([] as GraphRelationship[]).values();
}

export const createKnowledgeGraph = (): KnowledgeGraph => {
  const nodeMap = new Map<string, GraphNode>();
  const relationshipMap = new Map<string, GraphRelationship>();
  // Per-type index maintained alongside `relationshipMap`. Bucket
  // values are `Map<id, Relationship>` so per-type iteration is cheap
  // and per-edge removal is O(1). See plan
  // docs/plans/2026-04-20-002-perf-parse-heritage-mro-plan.md (Unit 1).
  const relationshipsByType = new Map<RelationshipType, Map<string, GraphRelationship>>();
  // Reverse-adjacency index: nodeId → Set<relId> of every edge where
  // this node appears as source OR target. Maintained on writeRel /
  // deleteRel so `removeNode` can delete a node's edges in
  // O(edges-touching-node) instead of O(total-edges).
  const edgeIdsByNode = new Map<string, Set<string>>();
  // File index: filePath → Set<nodeId>. Maintained on addNode /
  // removeNode so `removeNodesByFile` reaches its file's nodes
  // directly instead of scanning the whole node map.
  const nodeIdsByFile = new Map<string, Set<string>>();

  // Private helpers that encode the dual-index invariants in one
  // place. All mutation paths go through these — adding a new
  // mutation method only needs to call the helper, not remember to
  // touch every index.
  const addToBucket = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
    let bucket = map.get(key);
    if (bucket === undefined) {
      bucket = new Set();
      map.set(key, bucket);
    }
    bucket.add(value);
  };
  const removeFromBucket = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
    const bucket = map.get(key);
    if (bucket === undefined) return;
    bucket.delete(value);
    if (bucket.size === 0) map.delete(key);
  };

  const writeRel = (rel: GraphRelationship): void => {
    relationshipMap.set(rel.id, rel);
    let typeBucket = relationshipsByType.get(rel.type);
    if (typeBucket === undefined) {
      typeBucket = new Map();
      relationshipsByType.set(rel.type, typeBucket);
    }
    typeBucket.set(rel.id, rel);
    addToBucket(edgeIdsByNode, rel.sourceId, rel.id);
    // Guard against a self-edge writing the same rel.id into the
    // same Set twice — Set dedup handles it, but we skip explicitly
    // for clarity.
    if (rel.targetId !== rel.sourceId) {
      addToBucket(edgeIdsByNode, rel.targetId, rel.id);
    }
  };
  const deleteRel = (rel: GraphRelationship): void => {
    relationshipMap.delete(rel.id);
    const typeBucket = relationshipsByType.get(rel.type);
    if (typeBucket !== undefined) {
      typeBucket.delete(rel.id);
      if (typeBucket.size === 0) relationshipsByType.delete(rel.type);
    }
    removeFromBucket(edgeIdsByNode, rel.sourceId, rel.id);
    if (rel.targetId !== rel.sourceId) {
      removeFromBucket(edgeIdsByNode, rel.targetId, rel.id);
    }
  };

  const addNode = (node: GraphNode) => {
    if (nodeMap.has(node.id)) return;
    nodeMap.set(node.id, node);
    const filePath = node.properties?.filePath;
    if (typeof filePath === 'string' && filePath.length > 0) {
      addToBucket(nodeIdsByFile, filePath, node.id);
    }
  };

  const addRelationship = (relationship: GraphRelationship) => {
    if (relationshipMap.has(relationship.id)) return;
    writeRel(relationship);
  };

  /**
   * Remove a single node and all relationships involving it.
   * O(edges-touching-node) via the reverse-adjacency index — no full
   * relationshipMap scan.
   */
  const removeNode = (nodeId: string): boolean => {
    const node = nodeMap.get(nodeId);
    if (node === undefined) return false;

    nodeMap.delete(nodeId);
    const filePath = node.properties?.filePath;
    if (typeof filePath === 'string' && filePath.length > 0) {
      removeFromBucket(nodeIdsByFile, filePath, nodeId);
    }

    const touchingEdgeIds = edgeIdsByNode.get(nodeId);
    if (touchingEdgeIds !== undefined) {
      // Snapshot the ids before iterating — deleteRel mutates the same
      // Set via removeFromBucket, which would break mid-loop iteration.
      for (const relId of [...touchingEdgeIds]) {
        const rel = relationshipMap.get(relId);
        if (rel !== undefined) deleteRel(rel);
      }
      edgeIdsByNode.delete(nodeId);
    }
    return true;
  };

  /**
   * Remove a single relationship by id.
   * Returns true if the relationship existed and was removed, false otherwise.
   */
  const removeRelationship = (relationshipId: string): boolean => {
    const rel = relationshipMap.get(relationshipId);
    if (rel === undefined) return false;
    deleteRel(rel);
    return true;
  };

  /**
   * Remove all nodes (and their relationships) belonging to a file.
   * O(file-nodes × avg-edges-per-node) via the file index — no full
   * node-map scan.
   */
  const removeNodesByFile = (filePath: string): number => {
    const nodeIds = nodeIdsByFile.get(filePath);
    if (nodeIds === undefined) return 0;
    // Snapshot before iterating — removeNode mutates nodeIdsByFile.
    const snapshot = [...nodeIds];
    for (const nodeId of snapshot) removeNode(nodeId);
    return snapshot.length;
  };

  return {
    get nodes() {
      return Array.from(nodeMap.values());
    },

    get relationships() {
      return Array.from(relationshipMap.values());
    },

    iterNodes: () => nodeMap.values(),
    iterRelationships: () => relationshipMap.values(),
    iterRelationshipsByType: (type: RelationshipType) => {
      const bucket = relationshipsByType.get(type);
      return bucket === undefined ? emptyRelIter() : bucket.values();
    },
    forEachNode(fn: (node: GraphNode) => void) {
      nodeMap.forEach(fn);
    },
    forEachRelationship(fn: (rel: GraphRelationship) => void) {
      relationshipMap.forEach(fn);
    },
    getNode: (id: string) => nodeMap.get(id),

    // O(1) count getters - avoid creating arrays just for length
    get nodeCount() {
      return nodeMap.size;
    },

    get relationshipCount() {
      return relationshipMap.size;
    },

    addNode,
    addRelationship,
    removeNode,
    removeNodesByFile,
    removeRelationship,
  };
};
