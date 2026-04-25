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
  getNode: (id: string) => GraphNode | undefined;
  nodeCount: number;
  relationshipCount: number;
  addNode: (node: GraphNode) => void;
  addRelationship: (relationship: GraphRelationship) => void;
  removeNode: (nodeId: string) => boolean;
  removeNodesByFile: (filePath: string) => number;
  removeRelationship: (relationshipId: string) => boolean;
}
