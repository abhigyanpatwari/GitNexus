import type { KnowledgeGraph } from '../graph/types.js';
import { SPRING_CONFIG_UNRESOLVED_PREFIX } from '../ingestion/frameworks/spring/config-bindings.js';

export interface PersistedSpringConfigConsumerRow {
  readonly id?: unknown;
  readonly description?: unknown;
}

const CONSUMER_LABELS = new Set(['Property', 'Class', 'Record']);

function unresolvedKeys(description: unknown): readonly string[] {
  if (typeof description !== 'string') return [];
  return description
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(SPRING_CONFIG_UNRESOLVED_PREFIX))
    .map((part) => part.slice(SPRING_CONFIG_UNRESOLVED_PREFIX.length))
    .sort();
}

/**
 * Find unchanged Spring consumer files whose unresolved markers changed.
 *
 * A removed config key also removes the old USES edge from the fresh graph, so
 * ordinary new-graph boundary expansion cannot discover the consumer file.
 */
export function collectSpringConfigConsumerDriftFiles(
  graph: KnowledgeGraph,
  persistedRows: readonly PersistedSpringConfigConsumerRow[],
): Set<string> {
  const persistedById = new Map<string, readonly string[]>();
  for (const row of persistedRows) {
    if (typeof row.id !== 'string') continue;
    persistedById.set(row.id, unresolvedKeys(row.description));
  }

  const driftFiles = new Set<string>();
  graph.forEachNode((node) => {
    if (!CONSUMER_LABELS.has(node.label)) return;
    const filePath = node.properties.filePath;
    if (typeof filePath !== 'string') return;
    const description = node.properties.description;
    const persisted = persistedById.get(node.id);
    if (
      persisted === undefined &&
      (typeof description !== 'string' || !description.includes(SPRING_CONFIG_UNRESOLVED_PREFIX))
    ) {
      return;
    }
    const current = unresolvedKeys(description);
    const prior = persisted ?? [];
    if (current.length !== prior.length || current.some((key, index) => key !== prior[index])) {
      driftFiles.add(filePath);
    }
  });
  return driftFiles;
}
