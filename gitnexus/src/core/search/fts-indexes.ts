import { createFTSIndex, dropFTSIndex } from '../lbug/lbug-adapter.js';
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
    // Drop first so the live `properties` always win. `createFTSIndex` is
    // idempotent-by-name (skips when the index already exists), so without the
    // drop a schema change — e.g. adding `description` (#2299) — would never
    // reach an existing `.lbug` DB on an incremental re-analyze or `--repair-fts`;
    // the old name+content index would silently persist. `dropFTSIndex` no-ops
    // when the index is absent (first-ever analyze) and clears the per-connection
    // memo so the create below actually runs.
    // ponytail: this rebuilds every FTS index on every analyze instead of
    // skipping when present; FTS build is proportional to symbol-table size and
    // runs inside the existing FTS phase. Gate on a stored schema fingerprint if
    // this rebuild cost ever shows up in analyze profiles.
    await dropFTSIndex(table, indexName);
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
