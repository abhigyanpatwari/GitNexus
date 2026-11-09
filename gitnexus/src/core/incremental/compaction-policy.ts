import type { KnowledgeGraph } from '../graph/types.js';

/** Receipt from the last successful physical graph write, scoped to its index. */
export interface GraphCompactionState {
  version: 1;
  compactBytes: number;
  incrementalWrites: number;
}

export const MAX_INCREMENTAL_WRITES = 16;
export const MAX_STORAGE_GROWTH_FRACTION = 0.5;
export const MIN_STORAGE_GROWTH_BYTES = 16 * 1024 * 1024;
export const MAX_INCREMENTAL_MUTATION_ROWS = 2_000;
export const COMPACTION_MUTATION_FRACTION = 0.05;

/** The small-graph row budget scales up so modest monorepo edits stay selective. */
export function incrementalMutationLimit(graph: KnowledgeGraph): number {
  return Math.max(
    MAX_INCREMENTAL_MUTATION_ROWS,
    Math.ceil((graph.nodeCount + graph.relationshipCount) * COMPACTION_MUTATION_FRACTION),
  );
}

export function isGraphCompactionState(value: unknown): value is GraphCompactionState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<GraphCompactionState>;
  return (
    state.version === 1 &&
    typeof state.compactBytes === 'number' &&
    Number.isSafeInteger(state.compactBytes) &&
    state.compactBytes > 0 &&
    typeof state.incrementalWrites === 'number' &&
    Number.isSafeInteger(state.incrementalWrites) &&
    state.incrementalWrites >= 0
  );
}

/** Missing evidence requires one fresh COPY to establish a trustworthy baseline. */
export function graphCompactionReason(
  state: unknown,
  currentBytes: number | undefined,
): string | undefined {
  if (!isGraphCompactionState(state)) return 'the compact storage baseline is missing or invalid';
  if (
    typeof currentBytes !== 'number' ||
    !Number.isSafeInteger(currentBytes) ||
    currentBytes <= 0
  ) {
    return 'the current graph size could not be measured';
  }
  if (state.incrementalWrites >= MAX_INCREMENTAL_WRITES) {
    return `${state.incrementalWrites} incremental writes have accumulated since the last compact build`;
  }
  const allowance = Math.max(
    MIN_STORAGE_GROWTH_BYTES,
    state.compactBytes * MAX_STORAGE_GROWTH_FRACTION,
  );
  if (currentBytes - state.compactBytes > allowance) {
    return `physical storage grew from ${state.compactBytes} to ${currentBytes} bytes`;
  }
  return undefined;
}

/** Count only up to the mutation budget; one large source file can exceed it. */
export function incrementalMutationRows(
  graph: KnowledgeGraph,
  files: ReadonlySet<string>,
  limit = incrementalMutationLimit(graph),
): number {
  const ids = new Set<string>();
  let rows = 0;
  for (const node of graph.iterNodes()) {
    const filePath = node.properties.filePath;
    if (!filePath || !files.has(filePath)) continue;
    ids.add(node.id);
    if (++rows >= limit) return rows;
  }
  for (const edge of graph.iterRelationships()) {
    if (ids.has(edge.sourceId) || ids.has(edge.targetId)) {
      if (++rows >= limit) return rows;
    }
  }
  return rows;
}
