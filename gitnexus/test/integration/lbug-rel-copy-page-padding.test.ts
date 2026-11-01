import fs from 'node:fs/promises';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { expect, it } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

// LadybugDB #1059/#1091: uncompressed relationship COPY allocated whole pages
// but wrote only the payload. On 0.21.1 this fixture leaves the file 3,936 bytes
// short; an immediate scan can still pass while the pages remain buffered.
it('pads uncheckpointed relationship COPY pages and preserves their rows', async () => {
  const temp = await createTempDir();
  const dbPath = path.join(temp.dbPath, 'lbug');
  const db = new lbug.Database(dbPath, 64 * 1024 * 1024, false, false, 1024 ** 3, false);
  const conn = new lbug.Connection(db);
  const query = async (cypher: string): Promise<Array<Record<string, unknown>>> => {
    const raw = await conn.query(cypher);
    const rows: Array<Record<string, unknown>> = [];
    for (const result of Array.isArray(raw) ? raw : [raw]) {
      try {
        rows.push(...(await result.getAll()));
      } finally {
        result.close();
      }
    }
    return rows;
  };

  try {
    await query('CALL force_checkpoint_on_close=false');
    await query('CREATE NODE TABLE N(id INT64 PRIMARY KEY)');
    await query('CREATE REL TABLE R(FROM N TO N, weight INT64)');
    await query('UNWIND range(0, 999) AS i CREATE (:N {id: i})');
    await query('CHECKPOINT');

    const expected = Array.from({ length: 1000 }, (_, i) => ({
      source: i,
      target: (i + 1) % 1000,
      weight: i,
    }));
    const csvPath = path.join(temp.dbPath, 'rels.csv');
    await fs.writeFile(
      csvPath,
      expected.map(({ source, target, weight }) => `${source},${target},${weight}\n`).join(''),
    );
    const csvLiteral = csvPath.replace(/\\/g, '/').replace(/'/g, "\\'");
    await query(`COPY R FROM '${csvLiteral}' (HEADER=false, PARALLEL=false)`);

    // Check before a scan or checkpoint can conceal the short native flush.
    expect((await fs.stat(dbPath)).size % 4096).toBe(0);
    const scan = `MATCH (a:N)-[r:R]->(b:N)
      RETURN a.id AS source, b.id AS target, r.weight AS weight ORDER BY weight`;
    expect(await query(scan)).toEqual(expected);

    await query(
      'MATCH (a:N), (b:N) WHERE a.id = 0 AND b.id = 500 CREATE (a)-[:R {weight: 1000}]->(b)',
    );
    expected.push({ source: 0, target: 500, weight: 1000 });
    expect(await query(scan)).toEqual(expected);
    await query('CHECKPOINT');
    expect((await fs.stat(dbPath)).size % 4096).toBe(0);
    expect(await query(scan)).toEqual(expected);
  } finally {
    try {
      await conn.close();
    } finally {
      try {
        await db.close();
      } finally {
        await temp.cleanup();
      }
    }
  }
}, 120_000);
