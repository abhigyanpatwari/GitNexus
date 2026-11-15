#!/usr/bin/env node
// Real CSV/COPY and composite-key replacement; no mocked persistence.
// node --import tsx bench/embedding-identities/measure.cjs [--check]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const source = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
(async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(__dirname, 'baseline.json'), 'utf8'));
  assert.equal(baseline.version, 1);
  process.env.GITNEXUS_EMBEDDING_DIMS = String(baseline.dimensions);
  const adapter = await source('core/lbug/lbug-adapter.ts');
  const { batchInsertEmbeddings } = await source('core/embeddings/embedding-pipeline.ts');
  const { createKnowledgeGraph } = await source('core/graph/graph.ts');
  const results = [];
  for (const nodes of baseline.sizes) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-embedding-identity-bench-'));
    try {
      const graph = createKnowledgeGraph();
      const rows = [];
      for (let i = 0; i < nodes; i++) {
        const id = `Function:source${Math.floor(i / 32)}.ts:fn${i}`;
        graph.addNode({
          id,
          label: 'Function',
          properties: {
            name: `fn${i}`,
            filePath: `source${Math.floor(i / 32)}.ts`,
            startLine: i,
            endLine: i + 1,
          },
        });
        rows.push({
          nodeId: id,
          chunkIndex: 0,
          startLine: i,
          endLine: i + 1,
          contentHash: `hash-${i}`,
          embedding: Array(baseline.dimensions).fill(0.125),
        });
      }
      const copy = [];
      const insert = [];
      for (let trial = 0; trial < 4; trial++) {
        const dbPath = path.join(dir, `lbug-${trial}`);
        await adapter.initLbug(dbPath, { skipFts: true });
        let start = performance.now();
        await adapter.loadGraphToLbug(graph, dir, dir, undefined, undefined, undefined, 'none');
        const copyMs = performance.now() - start;
        // Seed then replace the exact same keys, exercising idempotent retries.
        for (let i = 0; i < rows.length; i += baseline.batch_size) {
          await batchInsertEmbeddings(
            adapter.executeWithReusedStatement,
            rows.slice(i, i + baseline.batch_size),
          );
        }
        start = performance.now();
        for (let i = 0; i < rows.length; i += baseline.batch_size) {
          await batchInsertEmbeddings(
            adapter.executeWithReusedStatement,
            rows.slice(i, i + baseline.batch_size),
          );
        }
        const insertMs = performance.now() - start;
        await adapter.closeLbug();
        await adapter.initLbug(dbPath, { skipFts: true });
        const persisted = await adapter.executeQuery(
          'MATCH (e:CodeEmbedding) RETURN e.id AS id, e.nodeId AS nodeId, e.contentHash AS hash',
        );
        assert.equal(persisted.length, nodes);
        const expected = new Map(rows.map((row) => [`${row.nodeId}:0`, row]));
        for (const row of persisted) {
          const wanted = expected.get(row.id);
          assert.ok(wanted);
          assert.equal(row.nodeId, wanted.nodeId);
          assert.equal(row.hash, wanted.contentHash);
          expected.delete(row.id);
        }
        assert.equal(expected.size, 0);
        await adapter.closeLbug();
        if (trial > 0) {
          copy.push(copyMs);
          insert.push(insertMs);
        }
      }
      const median = (samples) => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
      results.push({ nodes, copy_ms: median(copy), replace_ms: median(insert) });
    } finally {
      await adapter.closeLbug();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  const scaling = {};
  for (const key of ['copy_ms', 'replace_ms']) {
    scaling[key] = results[1][key] / results[0][key] / (results[1].nodes / results[0].nodes);
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        cpu: os.cpus()[0]?.model,
        results,
        normalized_scaling: scaling,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--check')) {
    const sameRuntime =
      baseline.runtime.node === process.version &&
      baseline.runtime.platform === process.platform &&
      baseline.runtime.cpu === os.cpus()[0]?.model;
    if (!sameRuntime)
      console.warn(
        'Absolute timing gate skipped: baseline runtime differs; correctness and scaling gates still apply.',
      );
    for (const [key, value] of Object.entries(scaling))
      assert.ok(value <= baseline.linear_scaling_budget, `${key} scaling ${value}`);
    for (const row of results) {
      const original = baseline.results.find((item) => item.nodes === row.nodes);
      for (const key of ['copy_ms', 'replace_ms'])
        if (sameRuntime)
          assert.ok(
            row[key] / original[key] <= baseline.regression_budget,
            `${row.nodes} ${key} regression ${row[key] / original[key]}`,
          );
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
