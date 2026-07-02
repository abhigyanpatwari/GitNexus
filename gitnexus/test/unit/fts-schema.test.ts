import { describe, expect, it } from 'vitest';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';
import { NODE_SCHEMA_QUERIES } from '../../src/core/lbug/schema.js';
import { EMBEDDABLE_LABELS } from '../../src/core/embeddings/types.js';

/**
 * Parse a `CREATE NODE TABLE` DDL string into its table name and declared
 * column names. Kept `if`-free so it never introduces a vacuous assertion path.
 */
const parseTableColumns = (ddl: string): { table: string; columns: string[] } => {
  const table = ddl.match(/CREATE NODE TABLE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/)?.[1] ?? '';
  const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
  const columns = body
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z]/)?.[1] ?? '')
    .filter((col) => col.length > 0 && col !== 'PRIMARY');
  return { table, columns };
};

const COLUMNS_BY_TABLE = new Map<string, Set<string>>(
  NODE_SCHEMA_QUERIES.map(parseTableColumns).map(({ table, columns }) => [table, new Set(columns)]),
);

describe('FTS_INDEXES', () => {
  it('keeps File at name+content only (File has no description column)', () => {
    const file = FTS_INDEXES.find((i) => i.table === 'File');
    expect(file).toMatchObject({ properties: ['name', 'content'] });
  });

  it('indexes description for the four original symbol tables', () => {
    const tables = ['Function', 'Class', 'Method', 'Interface'];
    const withoutDescription = tables.filter(
      (t) => !FTS_INDEXES.find((i) => i.table === t)?.properties.includes('description'),
    );
    expect(withoutDescription).toEqual([]);
  });

  it('only indexes columns that actually exist on each table', () => {
    const violations = FTS_INDEXES.flatMap((index) => {
      const columns = COLUMNS_BY_TABLE.get(index.table) ?? new Set<string>();
      return index.properties
        .filter((prop) => !columns.has(prop))
        .map((prop) => `${index.table}.${prop}`);
    });
    expect(violations).toEqual([]);
  });

  it('covers every embeddable symbol table', () => {
    const indexed = new Set(FTS_INDEXES.map((i) => i.table));
    const missing = EMBEDDABLE_LABELS.filter((label) => !indexed.has(label));
    expect(missing).toEqual([]);
  });

  it('uses unique, valid index names', () => {
    const names = FTS_INDEXES.map((i) => i.indexName);
    expect(new Set(names).size).toBe(names.length);
    const invalid = names.filter((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    expect(invalid).toEqual([]);
  });
});
