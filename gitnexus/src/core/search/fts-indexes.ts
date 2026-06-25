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
  // Read the catalog once and check each configured index both EXISTS and
  // covers its expected columns. A queryability-only probe (CALL QUERY_FTS_INDEX
  // ... catch) is not enough: a stale `name+content`-only index left on a
  // pre-#2299 DB stays queryable yet silently misses `description`, so the probe
  // would pass while doc-comment search is still broken (#2299). SHOW_INDEXES
  // exposes `property_names` (STRING[]) per index, so we assert coverage directly.
  const rows = await executeQuery('CALL SHOW_INDEXES() RETURN *');

  const propsByIndex = new Map<string, readonly string[]>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const indexName = record.index_name;
    const propertyNames = record.property_names;
    if (typeof indexName !== 'string' || !Array.isArray(propertyNames)) continue;
    propsByIndex.set(
      indexName,
      propertyNames.filter((p): p is string => typeof p === 'string'),
    );
  }

  const missing: string[] = [];
  for (const { table, indexName, properties } of FTS_INDEXES) {
    const actual = propsByIndex.get(indexName);
    // Absent from the catalog, or present but not covering every expected column.
    if (!actual || !properties.every((p) => actual.includes(p))) {
      missing.push(`${table}.${indexName}`);
    }
  }
  return missing;
}
