#!/usr/bin/env node
/**
 * #3958 / LadybugDB extensions#118/#123: COPY rejects a duplicate before FTS
 * has indexed it. Older engines try to delete its nonexistent document.
 * LBUG_MODULE and FTS_LIBRARY allow the same probe against an older engine.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lbug = require(process.env.LBUG_MODULE || '@ladybugdb/core');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ladybug-fts-copy-'));
  const extension =
    process.env.FTS_LIBRARY ||
    path.resolve(
      __dirname,
      '../../vendor/lbug-fts/prebuilds',
      `${process.platform}-${process.arch}`,
      'libfts.lbug_extension',
    );
  const literal = (value) => "'" + value.replace(/\\/g, '/').replaceAll("'", "\\'") + "'";
  let database;
  let connection;
  const checks = [];
  const query = async (sql) => {
    const raw = await connection.query(sql);
    const rows = [];
    const errors = [];
    for (const result of Array.isArray(raw) ? raw : [raw]) {
      try {
        rows.push(...(await result.getAll()));
      } catch (error) {
        errors.push(error);
      } finally {
        await result.close();
      }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '));
    return rows;
  };
  const close = async () => {
    try {
      await connection?.close();
    } finally {
      connection = undefined;
      await database?.close();
      database = undefined;
    }
  };
  const open = async () => {
    database = new lbug.Database(path.join(directory, 'db'), 256 * 1024 * 1024);
    connection = new lbug.Connection(database, 2);
    await query(`LOAD ${literal(extension)}`);
  };
  const search = async (term) =>
    (
      await query(
        `CALL QUERY_FTS_INDEX('File', 'file_fts', ${literal(term)}) RETURN node.id AS id ORDER BY id`,
      )
    ).map((row) => row.id);
  let stage = 'setup';
  try {
    await open();
    await query(
      'CREATE NODE TABLE File(id STRING PRIMARY KEY, name STRING, filePath STRING, content STRING)',
    );
    await query("CREATE (:File {id:'File:a.ts', name:'a.ts', filePath:'a.ts', content:'apple'})");
    await query("CALL CREATE_FTS_INDEX('File', 'file_fts', ['name', 'content'])");
    await query('CHECKPOINT');
    const csvPath = path.join(directory, 'delta.csv');
    await fs.writeFile(
      csvPath,
      'id,name,filePath,content\nFile:a.ts,a.ts,a.ts,banana\nFile:b.ts,b.ts,b.ts,cherry\n',
    );
    const copy =
      `COPY File(id, name, filePath, content) FROM ${literal(csvPath)} ` +
      `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false`;
    stage = 'duplicate-rejected';
    await assert.rejects(query(`${copy})`), /primary key|duplicat/i);
    assert.deepEqual(await search('apple'), ['File:a.ts']);
    assert.deepEqual(await search('banana'), []);
    assert.deepEqual(await search('cherry'), []);
    checks.push({ name: stage, ok: true });

    stage = 'copy-with-fts';
    await query(`${copy}, ignore_errors=true)`);
    assert.deepEqual(
      await query('MATCH (n:File) RETURN n.id AS id, n.content AS content ORDER BY id'),
      [
        { id: 'File:a.ts', content: 'apple' },
        { id: 'File:b.ts', content: 'cherry' },
      ],
    );
    assert.deepEqual(await search('apple'), ['File:a.ts']);
    assert.deepEqual(await search('banana'), []);
    assert.deepEqual(await search('cherry'), ['File:b.ts']);
    checks.push({ name: stage, ok: true });

    stage = 'delete-and-reopen';
    await query("MATCH (n:File {id:'File:b.ts'}) DELETE n");
    await query('CHECKPOINT');
    await close();
    await open();
    assert.deepEqual(await search('apple'), ['File:a.ts']);
    assert.deepEqual(await search('cherry'), []);
    assert.deepEqual(await query('MATCH (n:File) RETURN n.id AS id'), [{ id: 'File:a.ts' }]);
    checks.push({ name: stage, ok: true });

    stage = 'repair';
    await query("CALL DROP_FTS_INDEX('File', 'file_fts')");
    await query("CALL CREATE_FTS_INDEX('File', 'file_fts', ['name', 'content'])");
    assert.deepEqual(await search('apple'), ['File:a.ts']);
    checks.push({ name: stage, ok: true });
  } catch (error) {
    checks.push({ name: stage, ok: false, error: String(error) });
  } finally {
    try {
      await close();
    } catch (error) {
      checks.push({ name: 'close', ok: false, error: String(error) });
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ native: lbug.VERSION, checks }));
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
