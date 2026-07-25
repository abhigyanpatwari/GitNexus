/**
 * CLI-specific graph types.
 *
 * Shared types (NodeLabel, GraphNode, etc.) should be imported
 * directly from 'gitnexus-shared' at call sites.
 *
 * This file only defines the CLI's KnowledgeGraph with mutation methods.
 */
import type { GraphNode, GraphRelationship, RelationshipType } from 'gitnexus-shared';

// CLI-specific: full KnowledgeGraph with mutation methods for incremental updates
export interface KnowledgeGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  iterNodes: () => IterableIterator<GraphNode>;
  iterRelationships: () => IterableIterator<GraphRelationship>;
  /**
   * Iterate ONLY relationships of the given type, backed by a per-type
   * index maintained in `addRelationship` / `removeRelationship` /
   * `removeNode` / `removeNodesByFile`. Returns an empty iterator when
   * the graph contains no relationships of that type.
   *
   * Prefer this over `iterRelationships()` + per-edge type filtering
   * for hot paths (MRO setup, heritage walks). Backwards-compatible:
   * existing `iterRelationships()` callers keep working.
   */
  iterRelationshipsByType: (type: RelationshipType) => IterableIterator<GraphRelationship>;
  forEachNode: (fn: (node: GraphNode) => void) => void;
  forEachRelationship: (fn: (rel: GraphRelationship) => void) => void;
  /**
   * Zero-allocation relationship scan: fields, not objects (#2680).
   *
   * The whole-graph scans (the local-symbol pruner, community detection,
   * process extraction) read only these four fields, and materializing a
   * `GraphRelationship` per edge just to read them dominates iteration cost once
   * relationships are held columnar — measured at ~90 ms per analyze on a
   * million-edge graph. Prefer this over `forEachRelationship` in any pass that
   * walks every edge and needs no other field.
   */
  forEachRelationshipFields: (
    fn: (sourceId: string, targetId: string, type: RelationshipType, confidence: number) => void,
  ) => void;
  getNode: (id: string) => GraphNode | undefined;
  nodeCount: number;
  relationshipCount: number;
  addNode: (node: GraphNode) => void;
  addRelationship: (relationship: GraphRelationship) => void;
  removeNode: (nodeId: string) => boolean;
  removeNodesByFile: (filePath: string) => number;
  removeRelationship: (relationshipId: string) => boolean;
}
