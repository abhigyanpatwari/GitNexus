import { describe, it, expect } from 'vitest';
import { NODE_SCHEMA_QUERIES } from '../../src/core/lbug/schema.js';
import { getCopyQuery } from '../../src/core/lbug/lbug-adapter.js';
import type { NodeTableName } from '../../src/core/lbug/schema.js';

/**
 * A node column lives in THREE places that must agree:
 *
 *   1. the `CREATE NODE TABLE` DDL          (`lbug/schema.ts`)
 *   2. the CSV header + row builder         (`lbug/csv-generator.ts`)
 *   3. the explicit COPY column list        (`lbug/lbug-adapter.ts` getCopyQuery)
 *
 * Adding `isTestCode` to only (1) and (2) produced
 *   `COPY failed for Function: Number of columns mismatch. Expected 8 but got 9`
 * at load time, AFTER a full parse — the whole analyze wasted before the failure
 * surfaced. The DDL and the COPY list are the pair that can disagree silently,
 * so pin them to each other here.
 */

/** Parse column names out of a `CREATE NODE TABLE X (...)` statement. */
function ddlColumns(stmt: string): { table: string; columns: string[] } | null {
  const m = /CREATE NODE TABLE (\w+) \(([\s\S]*)\)/.exec(stmt);
  if (!m) return null;
  const [, table, body] = m;
  const columns = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('PRIMARY KEY'))
    .map((l) => l.replace(/,$/, '').split(/\s+/)[0])
    .filter((c): c is string => Boolean(c));
  return { table: table!, columns };
}

/** Parse column names out of a `COPY X(a, b, c) FROM ...` statement. */
function copyColumns(query: string): string[] | null {
  const m = /COPY\s+`?\w+`?\(([^)]*)\)/.exec(query);
  if (!m) return null;
  return m[1]!.split(',').map((c) => c.trim());
}

const ddl = NODE_SCHEMA_QUERIES.map(ddlColumns).filter(
  (d): d is { table: string; columns: string[] } => d !== null,
);

describe('node DDL and COPY column lists agree', () => {
  it('parsed the DDL at all (guard against a regex that silently matches nothing)', () => {
    expect(ddl.length).toBeGreaterThan(5);
    const fn = ddl.find((d) => d.table === 'Function');
    expect(fn?.columns).toContain('id');
    expect(fn?.columns).toContain('isTestCode');
  });

  for (const { table, columns } of ddl) {
    it(`${table}: COPY column list matches its DDL, in order`, () => {
      const query = getCopyQuery(table as NodeTableName, '/tmp/x.csv');
      const copied = copyColumns(query);
      // A table whose COPY omits an explicit list is out of scope — the
      // positional form cannot drift from the DDL.
      if (copied === null) return;
      expect(copied).toEqual(columns);
    });
  }
});

describe('isTestCode is declared everywhere a definition table needs it', () => {
  // The five tables carrying `isExported` are the definition-bearing ones; a
  // symbol in any of them can live in test code, so all five need the flag for
  // the reachability query to be answerable without path heuristics.
  const EXPECTED = ['Function', 'Class', 'Interface', 'Method', 'CodeElement'];

  for (const table of EXPECTED) {
    it(`${table} declares isTestCode in its DDL`, () => {
      const entry = ddl.find((d) => d.table === table);
      expect(entry, `${table} not found in NODE_SCHEMA_QUERIES`).toBeDefined();
      expect(entry!.columns).toContain('isTestCode');
    });

    it(`${table} COPY includes isTestCode`, () => {
      const copied = copyColumns(getCopyQuery(table as NodeTableName, '/tmp/x.csv'));
      expect(copied).toContain('isTestCode');
    });
  }
});
