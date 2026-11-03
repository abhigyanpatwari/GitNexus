#!/usr/bin/env node
// Actual vector-store/journal write cost, excluding model and graph ingestion.
// npm run build && node bench/analyze-resume/vector-store.mjs --check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { VectorStore } from '../../dist/core/lbug/vector-store.js';
import { EmbeddingJobJournal } from '../../dist/storage/embedding-job-journal.js';
import { openLbugConnection, closeLbugConnection } from '../../dist/core/lbug/lbug-config.js';

process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
const nodes = 512;
const dimensions = 256;
const unitNodes = 64;
const identity = 'a'.repeat(64);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-vector-measure-'));
const samples = [];
const manifest = {
  version: 1,
  sourceIdentity: identity,
  digest: 'b'.repeat(64),
  bytes: nodes / unitNodes,
  totalNodes: nodes,
  totalUnits: nodes / unitNodes,
  maximumUnitBytes: 1024,
};
const chunk = (node) => ({
  nodeId: `Function:source.ts:node${node}`,
  contentHash: 'same-input-hash',
  chunkIndex: 0,
  startLine: 1,
  endLine: 2,
  embedding: Array(dimensions).fill(0.125),
});

async function baseline(directory) {
  const handle = await openLbugConnection(lbug, path.join(directory, 'vectors'), {
    bufferPoolBytes: 64 * 1024 * 1024,
    threads: 1,
  });
  const prepared = new Map();
  async function query(sql, params) {
    let result;
    if (params) {
      let statement = prepared.get(sql);
      if (!statement) {
        statement = await handle.conn.prepare(sql);
        prepared.set(sql, statement);
      }
      result = await handle.conn.execute(statement, params);
    } else result = await handle.conn.query(sql);
    const parts = Array.isArray(result) ? result : [result];
    const rows = [];
    try {
      for (const part of parts) while (part.hasNext()) rows.push(part.getNextSync());
    } finally {
      for (const part of parts) part.close();
    }
    return rows;
  }
  try {
    await query(
      `CREATE NODE TABLE CodeEmbedding(id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[${dimensions}], contentHash STRING, PRIMARY KEY(id))`,
    );
    const start = performance.now();
    // The existing batchInsertEmbeddings path: prepared DELETE then CREATE,
    // with each write auto-committed and a checkpoint after the full pipeline.
    for (let offset = 0; offset < nodes; offset += unitNodes) {
      const rows = Array.from({ length: unitNodes }, (_, i) => chunk(offset + i));
      for (const row of rows)
        await query('MATCH (e:CodeEmbedding {id:$id}) DELETE e', { id: `${row.nodeId}:0` });
      for (const row of rows)
        await query(
          'CREATE (:CodeEmbedding {id:$id, nodeId:$nodeId, chunkIndex:$chunkIndex, startLine:$startLine, endLine:$endLine, embedding:$embedding, contentHash:$contentHash})',
          { id: `${row.nodeId}:0`, ...row },
        );
    }
    await query('CHECKPOINT');
    const ms = performance.now() - start;
    assert.equal(Number((await query('MATCH (e:CodeEmbedding) RETURN count(e) AS n'))[0].n), nodes);
    return ms;
  } finally {
    await closeLbugConnection(handle);
  }
}

async function durable(directory) {
  const store = await VectorStore.open({
    directory,
    identity,
    dimensions,
    bufferPoolBytes: 64 * 1024 * 1024,
    threads: 1,
    batchBytes: 1024 * 1024,
    mode: 'create',
  });
  try {
    const start = performance.now();
    const journal = await EmbeddingJobJournal.create(directory, identity, manifest);
    for (let offset = 0; offset < nodes; offset += unitNodes) {
      const ordinal = offset / unitNodes;
      const rows = Array.from({ length: unitNodes }, (_, i) => chunk(offset + i));
      await journal.begin({
        start: { unit: ordinal, offset: ordinal },
        next: { unit: ordinal + 1, offset: ordinal + 1 },
        nodes: unitNodes,
        origin: 'manifest',
      });
      await store.beginNodes(rows);
      await store.appendBatch(rows);
      const receipts = await store.finishNodes(
        rows.map(({ nodeId, contentHash }) => ({ nodeId, contentHash, chunks: 1 })),
      );
      await store.checkpointUnit(receipts);
      await journal.acknowledge({ reusedNodes: 0, chunks: unitNodes });
    }
    const ms = performance.now() - start;
    const state = journal.snapshot();
    assert.equal(state.completedNodes, nodes);
    assert.equal(state.chunks, nodes);
    assert.equal(state.active, null);
    assert.equal(await store.seal(nodes, nodes), 'exact');
    return ms;
  } finally {
    await store.close();
  }
}

try {
  for (let trial = 0; trial < 5; trial++) {
    for (const mode of trial % 2 ? ['durable', 'baseline'] : ['baseline', 'durable']) {
      const directory = path.join(root, `${trial}-${mode}`);
      await fs.mkdir(directory);
      samples.push({
        trial,
        mode,
        ms: await (mode === 'baseline' ? baseline : durable)(directory),
      });
    }
  }
  const median = (mode) =>
    samples
      .filter((s) => s.mode === mode)
      .map((s) => s.ms)
      .sort((a, b) => a - b)[2];
  const ratio = median('durable') / median('baseline');
  process.stdout.write(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        nodes,
        dimensions,
        unitNodes,
        samples,
        ratio,
      },
      null,
      2,
    ) + '\n',
  );
  if (process.argv.includes('--check'))
    assert.ok(ratio <= 1, `Durable native writes regressed: ${ratio.toFixed(3)}x`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
