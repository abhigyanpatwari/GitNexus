/**
 * Canonical identity of a knowledge graph, for comparing two runs.
 *
 * Two graphs are the same when they hold the same nodes (id, label and every
 * property) and the same relationships (id, type, both endpoints and every
 * property). The order in which a graph happens to store or emit them is not
 * part of its identity, so both lists are sorted; property keys are sorted for
 * the same reason. Nothing else is normalized: a changed confidence, reason or
 * evidence entry is a different graph.
 *
 * Order that affects computation (for example the order a pass visits import
 * targets) is asserted where that order is produced, not here.
 */
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

interface IterableGraph {
  iterNodes(): Iterable<GraphNode>;
  iterRelationships(): Iterable<GraphRelationship>;
}

export interface GraphIdentity {
  readonly nodes: readonly string[];
  readonly relationships: readonly string[];
}

/** JSON with object keys sorted at every depth; array order is preserved. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );
}

export function graphIdentity(graph: IterableGraph): GraphIdentity {
  return {
    nodes: [...graph.iterNodes()].map((node) => stableJson(node)).sort(),
    relationships: [...graph.iterRelationships()].map((rel) => stableJson(rel)).sort(),
  };
}
