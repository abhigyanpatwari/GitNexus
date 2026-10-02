#!/usr/bin/env node
/** Native-only selective COPY scan discrepancy; no parser, graph adapter or FTS. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lbug = require('@ladybugdb/core');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ladybug-copy-identity-'));
  let database;
  let connection;
  const close = async () => {
    // Retire this session before closing so failures or reopening cannot close it twice.
    const activeConnection = connection;
    const activeDatabase = database;
    connection = undefined;
    database = undefined;
    const errors = [];
    try {
      await activeConnection?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await activeDatabase?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Native resource cleanup failed');
  };
  const errors = [];
  try {
    const dbPath = path.join(directory, 'lbug');
    const count = 8192;
    const tuple = (i) => [
      `Function:src/owner${Math.floor(i / 32)}.ts:fn${i}`,
      `fn${i}`,
      `src/owner${Math.floor(i / 32)}.ts`,
      (i % 32) * 4,
      (i % 32) * 4 + 2,
    ];
    const indices = Array.from({ length: count }, (_, i) => i);
    const expected = new Set(indices.map((i) => JSON.stringify(tuple(i))));
    const csv = (rows) =>
      'id,name,filePath,startLine,endLine\n' +
      rows
        .map((i) =>
          tuple(i)
            .map((value) => JSON.stringify(value))
            .join(','),
        )
        .join('\n') +
      '\n';
    await fs.writeFile(path.join(directory, 'full.csv'), csv(indices));
    await fs.writeFile(
      path.join(directory, 'delta.csv'),
      csv(indices.filter((i) => i < 32 || i >= count - 32)),
    );

    // Match GitNexus's uncompressed native constructor and serial COPY options.
    const open = (readOnly) =>
      new lbug.Database(
        dbPath,
        256 * 1024 * 1024,
        false,
        readOnly,
        4 * 1024 ** 3,
        true,
        64 * 1024 * 1024,
        true,
        true,
      );
    database = open(false);
    connection = new lbug.Connection(database);
    const query = async (cypher, params) => {
      const result = params
        ? await connection.execute(await connection.prepare(cypher), params)
        : await connection.query(cypher);
      try {
        return await result.getAll();
      } finally {
        await result.close();
      }
    };
    const copy = (file) =>
      query(
        `COPY Function FROM "${path.join(directory, file).replace(/\\/g, '/')}" ` +
          `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`,
      );
    const phases = [];
    const scan = async (phase) => {
      const rows = await query(
        'MATCH (n:Function) RETURN id(n) AS internalID, n.id AS id, n.name AS name, ' +
          'n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine',
      );
      const key = (r) => JSON.stringify([r.id, r.name, r.filePath, r.startLine, r.endLine]);
      const bad = rows.filter((r) => !expected.has(key(r)));
      const actual = new Set(rows.map(key));
      const missing = [...expected].filter((value) => !actual.has(value)).length;
      phases.push({
        phase,
        rows: rows.length,
        wrong_tuples: bad.length,
        missing_tuples: missing,
        examples: bad.slice(0, 2),
      });
      return { rows, bad, missing };
    };
    await query(
      'CREATE NODE TABLE Function(id STRING, name STRING, filePath STRING, ' +
        'startLine INT64, endLine INT64, PRIMARY KEY(id))',
    );
    await copy('full.csv');
    await query('CHECKPOINT');
    const before = await scan('baseline');
    assert.equal(before.rows.length, count);
    assert.equal(before.missing, 0);
    const baselineIdsByOffset = new Map(before.rows.map((r) => [r.internalID.offset, r.id]));
    await query(
      "MATCH (n:Function) WHERE n.filePath IN ['src/owner0.ts', 'src/owner255.ts'] DETACH DELETE n",
    );
    const deleted = await scan('after-delete');
    assert.equal(deleted.rows.length, count - 64);
    assert.equal(deleted.bad.length, 0);
    await copy('delta.csv');
    const copied = await scan('after-copy');
    await query('CHECKPOINT');
    await scan('after-checkpoint');
    await close();
    database = open(true);
    connection = new lbug.Connection(database);
    const reopened = await scan('reopened');
    const pointLookups = [];
    for (const row of reopened.bad.slice(0, 2)) {
      const id = baselineIdsByOffset.get(row.internalID.offset);
      if (!id) continue;
      pointLookups.push({
        scan: row,
        lookup: await query(
          'MATCH (n:Function {id: $id}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, ' +
            'n.startLine AS startLine, n.endLine AS endLine',
          { id },
        ),
      });
    }
    process.stdout.write(
      JSON.stringify(
        {
          native_version: lbug.VERSION,
          node: process.version,
          phases,
          point_lookups: pointLookups,
          ...(process.argv.includes('--keep') ? { directory } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    if (process.argv.includes('--require-corruption')) {
      assert.ok(
        copied.bad.length > 0,
        'Native failure did not reproduce; this is a diagnostic, not a passing CI invariant',
      );
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!process.argv.includes('--keep'))
        await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Native benchmark failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
