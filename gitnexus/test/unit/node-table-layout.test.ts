import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import {
  CONST_SCHEMA,
  ENUM_SCHEMA,
  ENUM_VARIANT_SCHEMA,
  FUNCTION_SCHEMA,
  MODULE_SCHEMA,
  STRUCT_SCHEMA,
} from '../../src/core/lbug/schema.js';
import {
  getNodeTableCsvHeader,
  NODE_TABLE_LAYOUTS,
  type LayoutTableName,
} from '../../src/core/lbug/node-table-layout.js';
import { buildLayoutNodeRow, escapeCSVBoolean } from '../../src/core/lbug/csv-generator.js';
import { getCopyQuery } from '../../src/core/lbug/lbug-adapter.js';

const schemas: Record<LayoutTableName, string> = {
  Function: FUNCTION_SCHEMA,
  Struct: STRUCT_SCHEMA,
  Enum: ENUM_SCHEMA,
  EnumVariant: ENUM_VARIANT_SCHEMA,
  Const: CONST_SCHEMA,
  Module: MODULE_SCHEMA,
};

const ddlColumns = (ddl: string): string[] =>
  ddl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith(',') && !line.startsWith('PRIMARY KEY'))
    .map((line) => line.split(/\s+/, 1)[0]);

const copyColumns = (query: string): string[] => {
  const match = /^COPY\s+`?\w+`?\(([^)]+)\)/.exec(query);
  if (!match) throw new Error(`Could not parse COPY query: ${query}`);
  return match[1].split(',').map((value) => value.trim());
};

const csvCellCount = (row: string): number => {
  let cells = 1;
  let quoted = false;
  for (let index = 0; index < row.length; index++) {
    if (row[index] === '"') {
      if (quoted && row[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (row[index] === ',' && !quoted) {
      cells++;
    }
  }
  return cells;
};

describe('shared node-table persistence layouts', () => {
  it.each(Object.keys(NODE_TABLE_LAYOUTS) as LayoutTableName[])(
    '%s keeps DDL, CSV, row encoding, and COPY order aligned',
    (table) => {
      const columns = NODE_TABLE_LAYOUTS[table].columns.map(({ name }) => name);
      const node = {
        id: `${table}:fixture`,
        label: table,
        properties: {
          name: 'fixture',
          filePath: 'src/fixture.move',
          startLine: 1,
          endLine: 2,
          language: table === 'Function' ? 'typescript' : 'rust',
        },
      } as GraphNode;

      expect(ddlColumns(schemas[table])).toEqual(columns);
      expect(getNodeTableCsvHeader(table).split(',')).toEqual(columns);
      expect(csvCellCount(buildLayoutNodeRow(table, node, 'fixture content'))).toBe(columns.length);
      expect(copyColumns(getCopyQuery(table, '/tmp/fixture.csv'))).toEqual(columns);
    },
  );

  it('escapeCSVBoolean matches the incremental path truthy coercion (!!v) for non-boolean inputs', () => {
    // The bulk CSV path and the incremental CREATE/MERGE path (`!!properties.x`
    // in lbug-adapter) must classify the same value identically, or an
    // incremental top-up would flip a boolean column relative to a full
    // rebuild. Exercise the values a misbehaving extractor could emit.
    for (const value of [true, false, 1, 0, '0', '', 'false', undefined, null, {}]) {
      expect(escapeCSVBoolean(value)).toBe(value ? 'true' : 'false');
    }
  });

  it('rejects an unknown CSV column encoding instead of emitting an empty cell', () => {
    const column = NODE_TABLE_LAYOUTS.Function.columns[0];
    const mutableColumn = column as { csvEncoding: string };
    const originalEncoding = column.csvEncoding;
    const node = {
      id: 'Function:fixture',
      label: 'Function',
      properties: { name: 'fixture', filePath: 'src/fixture.ts' },
    } as GraphNode;

    try {
      mutableColumn.csvEncoding = 'future-encoding';
      expect(() => buildLayoutNodeRow('Function', node, 'fixture content')).toThrow(
        'Unsupported CSV column encoding: future-encoding',
      );
    } finally {
      mutableColumn.csvEncoding = originalEncoding;
    }
  });
});
