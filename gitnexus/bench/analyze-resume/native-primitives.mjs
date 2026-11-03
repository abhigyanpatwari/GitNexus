#!/usr/bin/env node
// Native feasibility probe, not an end-to-end analyze performance claim.
// node --expose-gc bench/analyze-resume/native-primitives.mjs [--check]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Database, Connection } = require('@ladybugdb/core');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-analyze-resume-'));
const nodes = 10_000;
const content = 'x'.repeat(4096);
const unit = 256;
const vectorNodes = 512;
const dimensions = 256;
const samples = [];

async function query(connection, text, parameters) {
  const result = parameters
    ? await connection.execute(await connection.prepare(text), parameters)
    : await connection.query(text);
  try {
    return await result.getAll();
  } finally {
    result.close();
  }
}

async function durableJson(file, value) {
  const handle = await fs.open(`${file}.tmp`, 'w');
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(`${file}.tmp`, file);
  // Directory fsync is unavailable on Windows; file fsync still runs there.
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

const graphPath = path.join(root, 'graph');
let graph;
let graphConnection;
try {
  graph = new Database(graphPath, 128 * 1024 * 1024);
  await graph.init();
  graphConnection = new Connection(graph, 2);
  await query(graphConnection, 'CREATE NODE TABLE N(id STRING, content STRING, PRIMARY KEY(id))');
  await query(
    graphConnection,
    `UNWIND range(0, ${nodes - 1}) AS i CREATE (:N {id: cast(i AS STRING), content: $content})`,
    { content },
  );
  await query(graphConnection, 'CHECKPOINT');
  await graphConnection.close();
  await graph.close();
  graph = new Database(graphPath, 128 * 1024 * 1024, true, true);
  await graph.init();
  graphConnection = new Connection(graph, 2);
  const fetchText = 'UNWIND $ids AS id MATCH (n:N {id:id}) RETURN n.id AS id, n.content AS content';
  const fetch = await graphConnection.prepare(fetchText);
  const plan = await query(graphConnection, `EXPLAIN ${fetchText}`, { ids: ['0'] });
  assert.match(JSON.stringify(plan), /PRIMARY_KEY_LOOKUP/);

  for (let trial = 0; trial < 5; trial++) {
    for (const mode of trial % 2 ? ['bounded', 'baseline'] : ['baseline', 'bounded']) {
      global.gc?.();
      const start = performance.now();
      let bytes = 0;
      let maximumContentBytes = 0;
      if (mode === 'baseline') {
        const rows = await query(
          graphConnection,
          'MATCH (n:N) RETURN n.id AS id, n.content AS content',
        );
        for (const row of rows) bytes += Buffer.byteLength(row.content);
        maximumContentBytes = bytes;
      } else {
        // This probe isolates native fetch cost. Production must persist keys
        // in its manifest; this small key array is not a bounded manifest.
        const keys = [];
        const result = await graphConnection.query('MATCH (n:N) RETURN n.id AS id ORDER BY n.id');
        try {
          while (result.hasNext()) keys.push(result.getNextSync().id);
        } finally {
          result.close();
        }
        for (let offset = 0; offset < keys.length; offset += unit) {
          const rows = await graphConnection.execute(fetch, {
            ids: keys.slice(offset, offset + unit),
          });
          let batchBytes = 0;
          try {
            while (rows.hasNext()) batchBytes += Buffer.byteLength(rows.getNextSync().content);
          } finally {
            rows.close();
          }
          bytes += batchBytes;
          maximumContentBytes = Math.max(maximumContentBytes, batchBytes);
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(maximumContentBytes <= unit * Buffer.byteLength(content));
      }
      assert.equal(bytes, nodes * Buffer.byteLength(content));
      samples.push({
        phase: 'read',
        trial,
        mode,
        ms: performance.now() - start,
        maximumContentBytes,
      });
    }
  }

  for (let trial = 0; trial < 3; trial++) {
    for (const mode of trial % 2 ? ['bounded', 'baseline'] : ['baseline', 'bounded']) {
      const vectors = new Database(path.join(root, `vectors-${trial}-${mode}`), 64 * 1024 * 1024);
      await vectors.init();
      const writer = new Connection(vectors, 2);
      try {
        await query(
          writer,
          `CREATE NODE TABLE E(id STRING, embedding FLOAT[${dimensions}], PRIMARY KEY(id))`,
        );
        // A fresh process must be able to read the published graph while the
        // vector writer is open. Same-process handle sharing cannot prove this.
        const child = execFileSync(
          process.execPath,
          [
            '-e',
            `
          const {Database,Connection}=require(${JSON.stringify(require.resolve('@ladybugdb/core'))});
          (async()=>{const db=new Database(${JSON.stringify(graphPath)},67108864,true,true);
          await db.init();const c=new Connection(db,2);
          const r=await c.query('MATCH (n:N) RETURN count(n) AS count');
          require('node:fs').writeSync(1,JSON.stringify(await r.getAll()));r.close();
          await c.close();await db.close();})().catch(e=>{console.error(e);process.exitCode=1});
        `,
          ],
          { encoding: 'utf8', timeout: 30_000 },
        );
        assert.equal(JSON.parse(child)[0].count, nodes);
        const insert = await writer.prepare('CREATE (:E {id:$id, embedding:$embedding})');
        const embedding = Array(dimensions).fill(0.125);
        const start = performance.now();
        for (let offset = 0; offset < vectorNodes; offset += 64) {
          if (mode === 'bounded') {
            await durableJson(path.join(root, 'job.json'), {
              completed: offset,
              active: offset / 64,
            });
            await query(writer, 'BEGIN TRANSACTION');
          }
          for (let i = offset; i < offset + 64; i++) {
            const result = await writer.execute(insert, { id: String(i), embedding });
            result.close();
          }
          if (mode === 'bounded') {
            await query(writer, 'COMMIT');
            await query(writer, 'CHECKPOINT');
            await durableJson(path.join(root, 'job.json'), { completed: offset + 64 });
          }
        }
        await query(writer, 'CHECKPOINT');
        samples.push({ phase: 'write', trial, mode, ms: performance.now() - start });
        assert.equal(
          (await query(writer, 'MATCH (n:E) RETURN count(n) AS count'))[0].count,
          vectorNodes,
        );
      } finally {
        await writer.close();
        await vectors.close();
      }
    }
  }
  const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const ratios = Object.fromEntries(
    ['read', 'write'].map((phase) => [
      phase,
      median(samples.filter((s) => s.phase === phase && s.mode === 'bounded').map((s) => s.ms)) /
        median(samples.filter((s) => s.phase === phase && s.mode === 'baseline').map((s) => s.ms)),
    ]),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        cpu: os.cpus()[0]?.model,
        nodes,
        unit,
        vectorNodes,
        dimensions,
        samples,
        ratios,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--check')) {
    for (const [phase, ratio] of Object.entries(ratios))
      assert.ok(ratio <= 1, `${phase} regressed: ${ratio}`);
  }
} finally {
  await graphConnection?.close();
  await graph?.close();
  await fs.rm(root, { recursive: true, force: true });
}
