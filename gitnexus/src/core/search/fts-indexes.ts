import { createFTSIndex } from '../lbug/lbug-adapter.js';
import { FTS_INDEXES } from './fts-schema.js';

export interface CreateSearchFTSIndexesOptions {
  onIndexStart?: (table: string, indexName: string) => void;
  onIndexReady?: (table: string, indexName: string) => void;
}

export async function createSearchFTSIndexes(
  options?: CreateSearchFTSIndexesOptions,
): Promise<void> {
  for (const { table, indexName, properties } of FTS_INDEXES) {
    options?.onIndexStart?.(table, indexName);
    await createFTSIndex(table, indexName, [...properties]);
    options?.onIndexReady?.(table, indexName);
  }
}

export async function verifySearchFTSIndexes(
  executeQuery: (cypher: string) => Promise<unknown[]>,
): Promise<string[]> {
  const safeIdentifier = (value: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error(`Invalid FTS identifier: ${value}`);
    }
    return value;
  };

  const missing: string[] = [];
  for (const { table, indexName } of FTS_INDEXES) {
    const safeTable = safeIdentifier(table);
    const safeIndex = safeIdentifier(indexName);
    const probe = `
      CALL QUERY_FTS_INDEX('${safeTable}', '${safeIndex}', '__gitnexus_fts_probe__', conjunctive := false)
      RETURN score
      LIMIT 1
    `;
    try {
      await executeQuery(probe);
    } catch {
      missing.push(`${table}.${indexName}`);
    }
  }
  return missing;
}
