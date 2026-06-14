import type { ConnectResult } from '../services/backend-client';
import type { KnowledgeGraph } from '../core/graph/types';
import { createKnowledgeGraph } from '../core/graph/graph';

/**
 * Whether the in-memory graph was downloaded ('full') or skipped for a large
 * project ('chatOnly'). Defined here (not in the graph state slice) so the
 * shared connect-result builder and the state slice agree on one source. In
 * chat-only mode `graph` is an empty-but-non-null KnowledgeGraph so existing
 * `graph?.` consumers keep working; the flag drives the chat-only UI. See #2178.
 */
export type GraphMode = 'full' | 'chatOnly';

export interface BuiltGraph {
  graph: KnowledgeGraph;
  graphMode: GraphMode;
  /**
   * Node count for the connected repo (from `repoInfo.stats.nodes`), or null
   * when the backend did not report it. Captured here at connect time so the
   * chat-only notice and its size warning have an authoritative value that does
   * not depend on the async `availableRepos` list having loaded yet.
   */
  nodeCount: number | null;
}

/**
 * Build the in-memory KnowledgeGraph from a connect result and derive the
 * graph mode + node count. In chat-only mode (`graphSkipped`) the node/relation
 * loops are skipped, leaving an empty-but-non-null graph.
 *
 * Shared by every connect entry point — App.handleServerConnect, switchRepo,
 * and loadGraphAnyway — so the build, the mode flag, and the node count stay in
 * lockstep instead of drifting across three near-identical copies. See #2178.
 */
export function buildGraphFromConnectResult(result: ConnectResult): BuiltGraph {
  const graph = createKnowledgeGraph();
  if (!result.graphSkipped) {
    for (const node of result.nodes) graph.addNode(node);
    for (const rel of result.relationships) graph.addRelationship(rel);
  }
  return {
    graph,
    graphMode: result.graphSkipped ? 'chatOnly' : 'full',
    nodeCount: result.repoInfo.stats?.nodes ?? null,
  };
}
