#!/usr/bin/env node
/** Native search contracts for #3421/#3423. See search-root-cause.md. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
// Diagnostic overrides allow the identical workload to test an older native engine.
const lbug = require(process.env.LBUG_MODULE || '@ladybugdb/core');
const scenario = process.argv[2];
assert.ok(
  ['context', 'property'].includes(scenario),
  'Usage: reproduce-search.cjs context|property [--keep]',
);

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ladybug-search-'));
  const checks = [];
  let database;
  let connection;
  const record = async (name, fn) => {
    try {
      checks.push({ name, ok: true, ...(await fn()) });
    } catch (error) {
      checks.push({ name, ok: false, error: String(error) });
    }
  };
  const close = async () => {
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
    if (errors.length) throw new AggregateError(errors, 'Native cleanup failed');
  };
  const query = async (sql, params) => {
    const raw = params
      ? await connection.execute(await connection.prepare(sql), params)
      : await connection.query(sql);
    const rows = [];
    const errors = [];
    // FTS expands into multiple statements: consume and close every result,
    // including when an earlier statement reports a deferred native error.
    for (const result of Array.isArray(raw) ? raw : [raw]) {
      try {
        rows.push(...(await result.getAll()));
      } catch (error) {
        errors.push(error);
      }
      try {
        await result.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('; '));
    return rows;
  };
  const table = scenario === 'context' ? 'Function' : 'Property';
  const columns = ['id', 'name', 'filePath', 'startLine', 'endLine'];
  if (scenario === 'property') columns.push('content', 'description');
  const indices = Array.from({ length: 8192 }, (_, i) => i);
  const changed = (i) => i < 32 || i >= 8192 - 32;
  const tuple = (i) =>
    scenario === 'context'
      ? [
          `Function:src/owner${Math.floor(i / 32)}.ts:unchangedSwiftTarget${i}`,
          `unchangedSwiftTarget${i}`, // Out-of-line name, unlike the short fn64 fixture.
          `src/owner${Math.floor(i / 32)}.ts`,
          (i % 32) * 4,
          (i % 32) * 4 + 2,
        ]
      : [
          `Property:src/owner${Math.floor(i / 32)}.swift:property${i}`,
          `unchangedPropertyValue${i}${'王'.repeat(i % 17)}`,
          `src/owner${Math.floor(i / 32)}.swift`,
          i,
          i + 1,
          `var unchangedPropertyValue${i} = "Valid UTF8 Å王 café 東京 ${i} ${'Résumé Ελληνικά Привет 🙂 '.repeat(i % 53)}"${i === 64 ? ' retainedsearchsentinel' : ''}`,
          `Documentation for property ${i} ${'正常な日本語 naïve façade Å王 '.repeat(i % 37)}`,
        ];
  const csv = (selected) =>
    columns.join(',') +
    '\n' +
    selected
      .map((i) =>
        tuple(i)
          .map((value) => '"' + String(value).replaceAll('"', '""') + '"')
          .join(','),
      )
      .join('\n') +
    '\n';
  const literal = (value) => "'" + value.replace(/\\/g, '/').replaceAll("'", "\\'") + "'";
  const copy = (file) =>
    query(
      `COPY ${table} FROM ${literal(path.join(directory, file))} ` +
        `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`,
    );
  const extension =
    process.env.FTS_LIBRARY ||
    path.resolve(
      __dirname,
      '../../vendor/lbug-fts/prebuilds',
      `${process.platform}-${process.arch}`,
      'libfts.lbug_extension',
    );
  const open = async (readOnly) => {
    database = new lbug.Database(
      path.join(directory, 'db'),
      256 * 1024 * 1024,
      false,
      readOnly,
      4 * 1024 ** 3,
      true,
      64 * 1024 * 1024,
      true,
      true,
    );
    connection = new lbug.Connection(database);
    if (scenario === 'property') await query(`LOAD ${literal(extension)}`);
  };
  const scan = async (stage, selected = indices) =>
    record(`${stage}:scan`, async () => {
      const rows = await query(
        `MATCH (n:${table}) RETURN ${columns.map((c) => `n.${c} AS ${c}`).join(', ')}`,
      );
      const expected = new Set(selected.map((i) => JSON.stringify(tuple(i))));
      const actual = rows.map((row) => JSON.stringify(columns.map((c) => row[c])));
      const actualSet = new Set(actual);
      const wrong = actual.filter((row) => !expected.has(row)).length;
      const missing = [...expected].filter((row) => !actualSet.has(row)).length;
      assert.deepEqual(
        { rows: rows.length, wrong, missing },
        { rows: selected.length, wrong: 0, missing: 0 },
      );
      return { rows: rows.length, wrong, missing };
    });
  const lookup = async (stage) => {
    const target = tuple(64); // Retained throughout DELETE/COPY.
    const select =
      'n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine';
    for (const [kind, sql, params] of [
      ['primary-key', `MATCH (n:Function {id: $uid}) RETURN ${select} LIMIT 1`, { uid: target[0] }],
      // Match LocalBackend.resolveContextSymbol's label-free UID/name queries.
      ['uid', `MATCH (n {id: $uid}) RETURN ${select} LIMIT 1`, { uid: target[0] }],
      [
        'name',
        `MATCH (n) WHERE n.name = $symName RETURN ${select} ORDER BY n.id LIMIT 20`,
        { symName: target[1] },
      ],
    ])
      await record(`${stage}:${kind}`, async () => {
        const rows = await query(sql, params);
        assert.deepEqual(
          rows.map((row) => columns.map((column) => row[column])),
          [target],
        );
        return { ids: rows.map((row) => row.id) };
      });
  };
  const build = () =>
    query("CALL CREATE_FTS_INDEX('Property', 'property_fts', ['name', 'content', 'description'])");
  const drop = () => query("CALL DROP_FTS_INDEX('Property', 'property_fts')");
  const search = async (stage) => {
    await record(`${stage}:catalog`, async () => {
      const indexes = await query('CALL SHOW_INDEXES() RETURN *');
      const matches = indexes.filter(
        (row) => row.table_name === 'Property' && row.index_name === 'property_fts',
      );
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0].property_names, ['name', 'content', 'description']);
      return { indexes: matches.length };
    });
    await record(`${stage}:fts-query`, async () => {
      const rows = await query(
        "CALL QUERY_FTS_INDEX('Property', 'property_fts', 'retainedsearchsentinel') RETURN node, score ORDER BY score DESC, node.id LIMIT 20",
      );
      const ids = rows.map((row) => row.node.id);
      assert.deepEqual(ids, [tuple(64)[0]]);
      return { ids };
    });
    for (const column of ['name', 'content', 'description'])
      await record(`${stage}:lower-${column}`, async () => {
        const rows = await query(`MATCH (n:Property) RETURN LOWER(n.${column}) AS value`);
        assert.equal(rows.length, indices.length);
        return { rows: rows.length };
      });
  };
  const check = async (stage) => {
    await scan(stage);
    if (scenario === 'context') await lookup(stage);
    else await search(stage);
  };
  try {
    await fs.writeFile(path.join(directory, 'full.csv'), csv(indices));
    await fs.writeFile(path.join(directory, 'delta.csv'), csv(indices.filter(changed)));
    await open(false);
    const schema = columns.map((c) => `${c} ${c.endsWith('Line') ? 'INT64' : 'STRING'}`).join(', ');
    await query(`CREATE NODE TABLE ${table}(${schema}, PRIMARY KEY(id))`);
    // Multiple labels make the UID query use a filtered scan, as in GitNexus.
    if (scenario === 'context') await query(`CREATE NODE TABLE Method(${schema}, PRIMARY KEY(id))`);
    await copy('full.csv');
    if (scenario === 'property') await record('baseline:build', build);
    await query('CHECKPOINT');
    await check('baseline');
    if (scenario === 'property') await drop();
    const suffix = scenario === 'context' ? 'ts' : 'swift';
    await query(
      `MATCH (n:${table}) WHERE n.filePath IN ['src/owner0.${suffix}', 'src/owner255.${suffix}'] DETACH DELETE n`,
    );
    await scan(
      'after-delete',
      indices.filter((i) => !changed(i)),
    );
    await copy('delta.csv');
    // Build first: scanning strings beforehand can change the old engine's error manifestation.
    if (scenario === 'property') await record('after-copy:build', build);
    await check('after-copy');
    if (scenario === 'property') {
      await record('repair:drop', drop);
      await record('repair:build', build);
      await check('repair');
    }
    await query('CHECKPOINT');
    await check('after-checkpoint');
    await close();
    await open(true);
    await check('reopened');
  } catch (error) {
    checks.push({ name: 'setup-or-write', ok: false, error: String(error) });
  } finally {
    await record('close', close);
    if (!process.argv.includes('--keep')) {
      await record('remove-fixture', () => fs.rm(directory, { recursive: true, force: true }));
    }
  }
  console.log(JSON.stringify({ scenario, native: lbug.VERSION, directory, checks }));
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
