/**
 * Integration test: BasicBlock + taint/PDG edge types round-trip the
 * bulk-COPY load path (issue #2080, U5 / R4 / AC2).
 *
 * Exercises the real csv-generator → loadGraphToLbug → COPY → query path:
 *  - a BasicBlock node (id/filePath/startLine/endLine/text) round-trips
 *  - one edge of each new type (CFG/REACHING_DEF/TAINTED/SANITIZES/TAINT_PATH,
 *    plus CDG/POST_DOMINATE from #2085 M5) between two BasicBlocks round-trips
 *    (asserts the new FROM/TO DDL pair + REL_TYPES load through bulk COPY)
 *  - REACHING_DEF carries its `variable` in the existing `reason` column
 *    (M0/S1 storage decision) and a variable-filtered query returns it
 *  - CDG carries its branch label ('T'|'F') in the same `reason` column
 *    (#2085 M5) and a label-filtered query returns it
 *  - the DDL (BASICBLOCK_SCHEMA wired into NODE_SCHEMA_QUERIES) loads on a
 *    fresh DB — if BASICBLOCK_SCHEMA were not in SCHEMA_QUERIES, initLbug would
 *    never create the table and these COPYs would fail (F1 guard, end-to-end)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { NODE_TABLES } from 'gitnexus-shared';
import { buildTestGraph } from '../helpers/test-graph.js';
import { getNodeQuery } from '../../src/server/api.js';

let tmpBase: string;
let storagePath: string;
let dbPath: string;

const BB1 = 'BasicBlock:src/a.ts:0';
const BB2 = 'BasicBlock:src/a.ts:1';
const NEW_EDGE_TYPES = [
  'CFG',
  'REACHING_DEF',
  'TAINTED',
  'SANITIZES',
  'TAINT_PATH',
  'CDG',
  'POST_DOMINATE',
] as const;

beforeAll(async () => {
  tmpBase = path.join(os.tmpdir(), `gitnexus-bb-roundtrip-${Date.now()}-${process.pid}`);
  storagePath = path.join(tmpBase, '.gitnexus');
  dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(dbPath, { recursive: true });

  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(dbPath);

  // Two BasicBlock nodes + one edge of each new type between them. The
  // REACHING_DEF edge stores its variable name ('x') in `reason`.
  const graph = buildTestGraph(
    [
      {
        id: BB1,
        label: 'BasicBlock',
        name: '', // BasicBlock has no name column; ignored by the writer
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 3,
        extra: { text: 'const x = req.body;' },
      },
      {
        id: BB2,
        label: 'BasicBlock',
        name: '',
        filePath: 'src/a.ts',
        startLine: 4,
        endLine: 6,
        extra: { text: 'sink(x);' },
      },
    ],
    NEW_EDGE_TYPES.map((type) => ({
      sourceId: BB1,
      targetId: BB2,
      type,
      reason: type === 'REACHING_DEF' ? 'x' : type === 'CDG' ? 'T' : `${type.toLowerCase()}-edge`,
    })),
  );

  await adapter.loadGraphToLbug(graph, tmpBase, storagePath);
});

afterAll(async () => {
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    /* may not have opened */
  }
  if (tmpBase) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(tmpBase, { recursive: true, force: true });
        return;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
});

describe('BasicBlock + taint/PDG edge round-trip (#2080)', () => {
  it('BasicBlock nodes round-trip with their source span and text', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      'MATCH (n:BasicBlock) RETURN n.id AS id, n.text AS text, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine ORDER BY n.id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(BB1);
    expect(rows[0].text).toBe('const x = req.body;');
    expect(rows[0].filePath).toBe('src/a.ts');
    expect(Number(rows[0].startLine)).toBe(1);
    expect(Number(rows[0].endLine)).toBe(3);
    expect(rows[1].id).toBe(BB2);
    expect(rows[1].text).toBe('sink(x);');
    expect(rows[1].filePath).toBe('src/a.ts');
    expect(Number(rows[1].endLine)).toBe(6);
  });

  // Regression guard: adding a node table whose columns differ from the
  // default (BasicBlock has no name/content) must not break the server's
  // graph read path. getNodeQuery is what /api/graph's buildGraph +
  // streamGraphNdjson run per NODE_TABLE; a default `n.name` projection on
  // BasicBlock raises a non-ignorable Ladybug binder error → HTTP 500 on
  // every analyzed repo. Assert every NODE_TABLE's query binds + runs, and
  // that BasicBlock returns its loaded rows.
  it('getNodeQuery binds + runs for every NODE_TABLE against the real schema', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    for (const table of NODE_TABLES) {
      for (const includeContent of [false, true]) {
        const q = getNodeQuery(table, includeContent);
        await expect(
          adapter.executeQuery(q),
          `getNodeQuery(${table}, includeContent=${includeContent}) should bind`,
        ).resolves.toBeDefined();
      }
    }
    const bbRows = await adapter.executeQuery(getNodeQuery('BasicBlock', false));
    expect(bbRows).toHaveLength(2);
  });

  it('each new edge type round-trips between the two BasicBlocks', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    // All edges live in the single CodeRelation table, keyed by `type`.
    for (const type of NEW_EDGE_TYPES) {
      const rows = await adapter.executeQuery(
        `MATCH (:BasicBlock)-[r:CodeRelation {type: '${type}'}]->(:BasicBlock) RETURN count(r) AS c`,
      );
      expect(Number(rows[0].c), `${type} edge should round-trip`).toBe(1);
    }
  });

  it('REACHING_DEF carries its variable in reason and is queryable by it', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      "MATCH (a:BasicBlock)-[r:CodeRelation {type: 'REACHING_DEF', reason: 'x'}]->(b:BasicBlock) RETURN a.id AS from, b.id AS to",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe(BB1);
    expect(rows[0].to).toBe(BB2);
  });

  it('CDG carries its branch label in reason and is queryable by it (#2085 M5)', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const rows = await adapter.executeQuery(
      "MATCH (a:BasicBlock)-[r:CodeRelation {type: 'CDG', reason: 'T'}]->(b:BasicBlock) RETURN a.id AS from, b.id AS to",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe(BB1);
    expect(rows[0].to).toBe(BB2);
  });
});
