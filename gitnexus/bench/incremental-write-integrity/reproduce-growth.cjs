#!/usr/bin/env node
/** Native storage amplification (#3852); no parser, FTS or concurrent writer. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const lbug = require('@ladybugdb/core');

async function main() {
  const large = process.argv.includes('--large');
  const count = large ? 65536 : 32768;
  const cycles = 12;
  const offsets = [1, 17, 257];
  const content = 'x'.repeat(1024);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-native-growth-'));
  const compactPath = path.join(directory, 'compact');
  const grownPath = path.join(directory, 'grown');
  let database;
  let connection;
  const open = async (file, readOnly = false) => {
    database = new lbug.Database(
      file,
      (large ? 1024 : 256) * 1024 ** 2,
      false,
      readOnly,
      4 * 1024 ** 3,
      true,
      64 * 1024 ** 2,
      true,
      true,
    );
    connection = new lbug.Connection(database);
    await connection.init();
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
    if (errors.length) throw new AggregateError(errors, 'Native resource cleanup failed');
  };
  const query = async (cypher) => {
    const result = await connection.query(cypher);
    try {
      return await result.getAll();
    } finally {
      await result.close();
    }
  };
  const copy = (table, file) =>
    query(
      `COPY ${table} FROM '${path.join(directory, file).replace(/\\/g, '/').replace(/'/g, "''")}' ` +
        `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`,
    );
  const csvRow = (values) =>
    values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',') + '\n';
  const node = (i) => [
    String(i),
    `fn${i}`,
    `src/owner${Math.floor(i / 32)}.ts`,
    (large ? `node${i}:` : '') + content,
  ];
  const edge = (i, j) => [
    String(i),
    String((i + offsets[j]) % count),
    `r${i}_${j}`,
    j === 0 ? 'CALLS' : 'USES',
  ];
  const fingerprint = async () => {
    const nodes = await query(
      'MATCH (n:Function) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content ORDER BY n.id',
    );
    const edges = await query(
      'MATCH (a:Function)-[r:CodeRelation]->(b:Function) RETURN a.id AS src, b.id AS dst, r.id AS id, r.type AS type ORDER BY r.id',
    );
    return {
      nodes: nodes.length,
      edges: edges.length,
      sha256: createHash('sha256')
        .update(JSON.stringify(nodes))
        .update(JSON.stringify(edges))
        .digest('hex'),
    };
  };
  const freePages = async () => {
    try {
      return (await query('CALL fsm_info() RETURN *')).reduce(
        (sum, row) => sum + Number(row.num_pages),
        0,
      );
    } catch (error) {
      return { unavailable: error.message };
    }
  };
  const errors = [];
  try {
    let nodes = 'id,name,filePath,content\n';
    let edges = 'from,to,id,type\n';
    for (let i = 0; i < count; i++) {
      nodes += csvRow(node(i));
      for (let j = 0; j < offsets.length; j++) edges += csvRow(edge(i, j));
    }
    await fs.writeFile(path.join(directory, 'nodes.csv'), nodes);
    await fs.writeFile(path.join(directory, 'edges.csv'), edges);
    nodes = undefined;
    edges = undefined;
    const bulkLoad = async (file) => {
      await open(file);
      await query(
        'CREATE NODE TABLE Function(id STRING, name STRING, filePath STRING, content STRING, PRIMARY KEY(id))',
      );
      await query(
        'CREATE REL TABLE CodeRelation(FROM Function TO Function, id STRING, type STRING)',
      );
      const started = performance.now();
      await copy('Function', 'nodes.csv');
      await copy('CodeRelation', 'edges.csv');
      await query('CHECKPOINT');
      return performance.now() - started;
    };
    const fullCopyMs = await bulkLoad(compactPath);
    const expected = await fingerprint();
    assert.equal(expected.nodes, count);
    assert.equal(expected.edges, count * offsets.length);
    const compactFreePages = await freePages();
    await close();
    const compactBytes = (await fs.stat(compactPath)).size;

    const oneOff = [];
    for (const [name, cypher] of [
      ['detach-delete', "MATCH (n:Function {id:'0'}) DETACH DELETE n"],
      [
        'edge-insert',
        "MATCH (a:Function {id:'0'}),(b:Function {id:'500'}) CREATE (a)-[:CodeRelation {id:'extra',type:'CALLS'}]->(b)",
      ],
      ['content-set', `MATCH (n:Function {id:'0'}) SET n.content='${node(0)[3]}'`],
    ]) {
      const file = path.join(directory, name);
      await fs.copyFile(compactPath, file);
      await open(file);
      const started = performance.now();
      await query(cypher);
      await query('CHECKPOINT');
      const elapsedMs = performance.now() - started;
      await close();
      const bytes = (await fs.stat(file)).size;
      oneOff.push({ name, bytes, ratio: bytes / compactBytes, elapsedMs });
    }

    await fs.copyFile(compactPath, grownPath);
    await open(grownPath);
    const deltas = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      const first = cycle * 32;
      const includes = (i) => i >= first && i < first + 32;
      let deltaNodes = 'id,name,filePath,content\n';
      let deltaEdges = 'from,to,id,type\n';
      for (let i = first; i < first + 32; i++) deltaNodes += csvRow(node(i));
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < offsets.length; j++) {
          if (includes(i) || includes((i + offsets[j]) % count)) deltaEdges += csvRow(edge(i, j));
        }
      }
      await fs.writeFile(path.join(directory, 'delta-nodes.csv'), deltaNodes);
      await fs.writeFile(path.join(directory, 'delta-edges.csv'), deltaEdges);
      const started = performance.now();
      await query(`MATCH (n:Function) WHERE n.filePath='src/owner${cycle}.ts' DETACH DELETE n`);
      await copy('Function', 'delta-nodes.csv');
      await copy('CodeRelation', 'delta-edges.csv');
      await query('CHECKPOINT');
      const bytes = (await fs.stat(grownPath)).size;
      deltas.push({
        cycle: cycle + 1,
        bytes,
        ratio: bytes / compactBytes,
        elapsedMs: performance.now() - started,
      });
      assert.deepEqual(await fingerprint(), expected, `tuple mismatch after rewrite ${cycle + 1}`);
    }
    assert.deepEqual(await fingerprint(), expected);
    const grownFreePages = await freePages();
    await close();

    // The control must recreate the file, not delete rows in the grown store.
    const rebuiltPath = path.join(directory, 'rebuilt');
    const rebuiltCopyMs = await bulkLoad(rebuiltPath);
    assert.deepEqual(await fingerprint(), expected);
    await close();
    const rebuiltBytes = (await fs.stat(rebuiltPath)).size;
    const measure = async (file) => {
      const samples = [];
      for (let i = 0; i < 8; i++) {
        const started = performance.now();
        await open(file, true);
        await query('RETURN 1');
        const openMs = performance.now() - started;
        const scanStarted = performance.now();
        const rows = await query(
          "MATCH ()-[r:CodeRelation]->() WHERE r.type='CALLS' RETURN count(r) AS n",
        );
        const scanMs = performance.now() - scanStarted;
        assert.equal(Number(rows[0].n), count);
        samples.push({ openMs, scanMs });
        await close();
      }
      const median = (key) =>
        samples
          .slice(1)
          .map((s) => s[key])
          .sort((a, b) => a - b)[3];
      return { openMs: median('openMs'), scanMs: median('scanMs') };
    };
    const compactQueries = await measure(compactPath);
    const grownQueries = await measure(grownPath);
    console.log(
      JSON.stringify(
        {
          nativeVersion: lbug.VERSION,
          node: process.version,
          large,
          count,
          oracle: expected,
          compactBytes,
          rebuiltBytes,
          fullCopyMs,
          rebuiltCopyMs,
          oneOff,
          deltas,
          compactFreePages,
          grownFreePages,
          compactQueries,
          grownQueries,
          ...(process.argv.includes('--keep') ? { directory } : {}),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
    if (!process.argv.includes('--keep')) {
      try {
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Native growth reproduction failed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
