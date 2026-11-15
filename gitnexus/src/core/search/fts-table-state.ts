import { FTS_INDEXES, type FTSIndexDefinition } from './fts-schema.js';

/**
 * Prove which searchable tables are empty using one bounded presence query.
 * No metadata or cross-request cache: a formerly empty table can gain rows.
 * Unreadable, missing or malformed evidence proves nothing, so callers retain
 * their normal index build/query/verification behavior on that path.
 */
export async function readEmptyFtsTables(
  executeQuery: (cypher: string) => Promise<unknown[]>,
  indexes: readonly FTSIndexDefinition[] = FTS_INDEXES,
): Promise<Set<string>> {
  const tables = [...new Set(indexes.map((index) => index.table))];
  if (tables.length === 0 || tables.some((table) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))) {
    return new Set();
  }
  try {
    const rows = await executeQuery(
      tables
        .map(
          // Aggregate before projecting the table name: grouping by a literal
          // yields no row for an empty table in LadybugDB.
          (table) => {
            // determinism: probe — only presence is returned, never row identity.
            return `MATCH (n:\`${table}\`) WITH n LIMIT 1 WITH count(n) AS rowCount RETURN '${table}' AS tableName, rowCount`;
          },
        )
        .join(' UNION ALL '),
    );
    if (!Array.isArray(rows) || rows.length !== tables.length) return new Set();
    const remaining = new Set(tables);
    const empty = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') return new Set();
      const { tableName, rowCount } = row as Record<string, unknown>;
      if (typeof tableName !== 'string' || !remaining.delete(tableName)) return new Set();
      if (
        !(typeof rowCount === 'number' && Number.isSafeInteger(rowCount) && rowCount >= 0) &&
        !(typeof rowCount === 'bigint' && rowCount >= 0n)
      )
        return new Set();
      if (rowCount === 0 || rowCount === 0n) empty.add(tableName);
    }
    return empty;
  } catch {
    return new Set();
  }
}
