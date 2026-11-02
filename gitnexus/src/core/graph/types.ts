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
   * process extraction) read only these five fields, and materializing a
   * `GraphRelationship` per edge just to read them dominates iteration cost once
   * relationships are held columnar — measured at ~90 ms per analyze on a
   * million-edge graph. Prefer this over `forEachRelationship` in any pass that
   * walks every edge and needs no other field.
   *
   * `reason` is passed because confidence alone cannot separate a heuristic
   * name guess from a resolved edge that happens to sit at the same number:
   * the global-name fallback emits at exactly the process/community threshold
   * (0.5), so the walks that must exclude it have to read the reason. See
   * `GraphEmitSink`'s reason column, added for this consumer.
   */
  forEachRelationshipFields: (
    fn: (
      sourceId: string,
      targetId: string,
      type: RelationshipType,
      confidence: number,
      reason: string,
    ) => void,
  ) => void;
  getNode: (id: string) => GraphNode | undefined;
  nodeCount: number;
  relationshipCount: number;
  addNode: (node: GraphNode) => void;
  addRelationship: (relationship: GraphRelationship) => void;
  removeNode: (nodeId: string) => boolean;
  removeNodesByFile: (filePath: string) => number;
  /**
   * Removes the relationship with this id, returning whether it existed.
   *
   * Implementations that offload relationships out of memory cannot always tell
   * "absent" from "already written out" — `GraphEmitSink` deliberately throws
   * rather than answering `false` for an edge it can no longer recall (#2680).
   */
  removeRelationship: (relationshipId: string) => boolean;
}
