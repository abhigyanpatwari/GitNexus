#!/usr/bin/env node
/** Native search contracts for #3421/#3423/#3564/#3569/#3474. See search-root-cause.md. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
// Diagnostic overrides allow the identical workload to test an older native engine.
const lbug = require(process.env.LBUG_MODULE || '@ladybugdb/core');
const scenario = process.argv[2];
assert.ok(
  ['context', 'property', 'method', 'embedding'].includes(scenario),
  'Usage: reproduce-search.cjs context|property|method|embedding [--keep]',
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
  const table = {
    context: 'Function',
    property: 'Property',
    method: 'Method',
    embedding: 'CodeEmbedding',
  }[scenario];
  const columns =
    scenario === 'embedding'
      ? ['id', 'nodeId', 'chunkIndex', 'startLine', 'endLine', 'contentHash']
      : ['id', 'name', 'filePath', 'startLine', 'endLine'];
  if (scenario === 'property') columns.push('content', 'description');
  if (scenario === 'method') columns.push('content');
  const indices = Array.from({ length: 8192 }, (_, i) => i);
  const changed = (i) => i < 32 || i >= 8192 - 32;
  const EMBEDDING_DIMS = 384; // schema.ts default
  const embeddingNode = (i) =>
    `Method:src/main/java/acme/Owner${Math.floor(i / 32)}.java:Owner${Math.floor(i / 32)}.method${i}#0`;
  const tuple = (i) =>
    scenario === 'embedding'
      ? [
          `${embeddingNode(i)}:0`,
          embeddingNode(i),
          0,
          (i % 32) * 4,
          (i % 32) * 4 + 2,
          `sha256:${i}`,
        ]
      : scenario === 'method'
        ? [
            `Method:checks/test_owner${Math.floor(i / 32)}.py:Checks.test_retained_method_${i}#0`,
            `test_retained_method_${i}`,
            `checks/test_owner${Math.floor(i / 32)}.py`,
            (i % 32) * 4,
            (i % 32) * 4 + 2,
            `    def test_retained_method_${i}(self):         value = ${i}         return value`,
          ]
        : scenario === 'context'
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
  // batchInsertEmbeddings: exact-id DELETE, then CREATE; never COPY (embedding-pipeline.ts).
  const insertEmbeddings = async (selected) => {
    const remove = await connection.prepare(`MATCH (e:${table} {id: $id}) DELETE e`);
    const create = await connection.prepare(
      `CREATE (e:${table} {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: $startLine, endLine: $endLine, embedding: $embedding, contentHash: $contentHash})`,
    );
    for (const i of selected) {
      const [id, nodeId, chunkIndex, startLine, endLine, contentHash] = tuple(i);
      await (await connection.execute(remove, { id })).close();
      const result = await connection.execute(create, {
        ...{ id, nodeId, chunkIndex, startLine, endLine, contentHash },
        embedding: Array.from({ length: EMBEDDING_DIMS }, (_, d) => ((i + d) % 97) / 97),
      });
      await result.close();
    }
  };
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
      'n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine' +
      (scenario === 'method' ? ', n.content AS content' : '');
    for (const [kind, sql, params] of [
      ['primary-key', `MATCH (n:${table} {id: $uid}) RETURN ${select} LIMIT 1`, { uid: target[0] }],
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
  // The stale-row DELETE and cache readers address embeddings by owner node id.
  const embeddingLookup = async () => {
    const rows = await query(
      `MATCH (e:${table} {nodeId: $nodeId}) RETURN ${columns.map((c) => `e.${c} AS ${c}`).join(', ')}`,
      { nodeId: embeddingNode(64) },
    );
    assert.deepEqual(
      rows.map((row) => columns.map((column) => row[column])),
      [tuple(64)],
    );
    return { ids: rows.map((row) => row.id) };
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
    if (scenario === 'embedding') await record(`${stage}:node-id`, embeddingLookup);
    else if (scenario !== 'property') await lookup(stage);
    else await search(stage);
  };
  try {
    if (scenario !== 'embedding') {
      await fs.writeFile(path.join(directory, 'full.csv'), csv(indices));
      await fs.writeFile(path.join(directory, 'delta.csv'), csv(indices.filter(changed)));
    }
    await open(false);
    const schema = columns.map((c) => `${c} ${c.endsWith('Line') ? 'INT64' : 'STRING'}`).join(', ');
    // The embedding table mirrors EMBEDDING_SCHEMA's column order and types.
    await query(
      scenario === 'embedding'
        ? `CREATE NODE TABLE ${table}(id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[${EMBEDDING_DIMS}], contentHash STRING, PRIMARY KEY(id))`
        : `CREATE NODE TABLE ${table}(${schema}, PRIMARY KEY(id))`,
    );
    // Multiple labels make the UID query use a filtered scan, as in GitNexus.
    if (scenario === 'context') await query(`CREATE NODE TABLE Method(${schema}, PRIMARY KEY(id))`);
    if (scenario === 'method')
      await query(`CREATE NODE TABLE Function(${schema}, PRIMARY KEY(id))`);
    if (scenario === 'embedding') {
      // One transaction keeps the 8,192-row baseline fast; only the delta is per-row.
      await query('BEGIN TRANSACTION');
      await insertEmbeddings(indices);
      await query('COMMIT');
    } else await copy('full.csv');
    if (scenario === 'property') await record('baseline:build', build);
    await query('CHECKPOINT');
    await check('baseline');
    if (scenario === 'property') await drop();
    if (scenario === 'embedding') {
      // deleteStaleEmbeddingRows: one DELETE per stale owner node.
      const statement = await connection.prepare(`MATCH (e:${table} {nodeId: $nodeId}) DELETE e`);
      for (const i of indices.filter(changed)) {
        await (await connection.execute(statement, { nodeId: tuple(i)[1] })).close();
      }
    } else {
      await query(
        `MATCH (n:${table}) WHERE n.filePath IN [${literal(tuple(0)[2])}, ${literal(tuple(8191)[2])}] DETACH DELETE n`,
      );
    }
    await scan(
      'after-delete',
      indices.filter((i) => !changed(i)),
    );
    if (scenario === 'embedding') await insertEmbeddings(indices.filter(changed));
    else await copy('delta.csv');
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
