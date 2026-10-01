#!/usr/bin/env node
/**
 * Native identity reconciliation overhead and scaling.
 * node --import tsx bench/incremental-write-integrity/measure.cjs [--check]
 *
 * COPY, graph construction, fingerprints and correctness controls are untimed.
 * Each timed sample includes all single-label scans and exact tuple checks.
 * Counts/fingerprints reject empty output; timing gates use normalized scaling.
 */
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const ROOT = resolve(__dirname, '../..');
const source = (file) => import(pathToFileURL(join(ROOT, file)).href);

(async () => {
  const { createKnowledgeGraph } = await source('src/core/graph/graph.ts');
  const { reconcileGraphNodeIdentities } = await source(
    'src/core/incremental/write-reconciliation.ts',
  );
  const adapter = await source('src/core/lbug/lbug-adapter.ts');
  const baseline = JSON.parse(await readFile(join(__dirname, 'baseline.json'), 'utf8'));
  assert.equal(baseline.version, 1);
  assert.ok(Number.isFinite(baseline.linear_scaling_budget) && baseline.linear_scaling_budget > 0);
  const results = [];
  for (const size of baseline.sizes) {
    assert.ok(Number.isSafeInteger(size.nodes) && size.nodes > 0);
    assert.match(size.fingerprint, /^[a-f0-9]{64}$/);
    const graph = createKnowledgeGraph();
    const hash = createHash('sha256');
    for (let i = 0; i < size.nodes; i++) {
      const id = `Function:src/owner${Math.floor(i / 32)}.ts:fn${i}`;
      const properties = {
        name: `fn${i}`,
        filePath: `src/owner${Math.floor(i / 32)}.ts`,
        startLine: (i % 32) * 4,
        endLine: (i % 32) * 4 + 2,
      };
      graph.addNode({ id, label: 'Function', properties });
      hash.update(
        JSON.stringify([
          id,
          properties.name,
          properties.filePath,
          properties.startLine,
          properties.endLine,
        ]) + '\n',
      );
    }
    assert.equal(hash.digest('hex'), size.fingerprint);
    const directory = await mkdtemp(join(tmpdir(), 'gnx-reconciliation-bench-'));
    try {
      await adapter.initLbug(join(directory, 'lbug'), { skipFts: true });
      await adapter.loadGraphToLbug(
        graph,
        directory,
        directory,
        undefined,
        undefined,
        undefined,
        'none',
      );
      await adapter.tryFlushWAL();
      const samples = [];
      let calls = 0;
      const query = async (sql) => {
        calls++;
        return adapter.executeQuery(sql);
      };
      for (let run = 0; run < 9; run++) {
        calls = 0;
        const start = performance.now();
        const receipt = await reconcileGraphNodeIdentities(graph, query, 'benchmark');
        const elapsed = performance.now() - start;
        assert.equal(receipt.nodes, size.nodes);
        assert.equal(calls, receipt.tables);
        if (run >= 2) samples.push(elapsed);
      }
      const first = graph.iterNodes().next().value;
      const alteredQuery = async (sql) => {
        const rows = await adapter.executeQuery(sql);
        if (sql.includes('(n:`Function`)')) rows.find((r) => r.id === first.id).startLine++;
        return rows;
      };
      await assert.rejects(
        reconcileGraphNodeIdentities(graph, alteredQuery, 'negative-control'),
        /startLine/,
      );
      await assert.rejects(
        reconcileGraphNodeIdentities(graph, async () => [], 'negative-control'),
        /missing ID/,
      );

      // Native 0.18.3 can corrupt scan projections after this real write, even
      // without FTS. Use an independent tuple-set oracle to require rejection
      // whenever the scan is wrong; a future native fix can pass normally.
      const { extractChangedSubgraph } = await source('src/core/incremental/subgraph-extract.ts');
      const files = new Set(['src/owner0.ts', `src/owner${Math.floor((size.nodes - 1) / 32)}.ts`]);
      const wanted = new Set(
        [...graph.iterNodes()].map((node) =>
          JSON.stringify([
            node.id,
            node.properties.name,
            node.properties.filePath,
            node.properties.startLine,
            node.properties.endLine,
          ]),
        ),
      );
      const nativePhases = [];
      const audit = async (phase) => {
        const rows = await adapter.executeQuery(
          'MATCH (n:Function) RETURN n.id AS id, n.name AS name, ' +
            'n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine',
        );
        const actual = new Set(
          rows.map((r) => JSON.stringify([r.id, r.name, r.filePath, r.startLine, r.endLine])),
        );
        const mismatched = [...wanted].filter((tuple) => !actual.has(tuple)).length;
        if (rows.length !== size.nodes || mismatched > 0 || actual.size !== wanted.size) {
          await assert.rejects(
            reconcileGraphNodeIdentities(graph, adapter.executeQuery, phase),
            /Graph identity reconciliation/,
          );
        } else {
          assert.equal(
            (await reconcileGraphNodeIdentities(graph, adapter.executeQuery, phase)).nodes,
            size.nodes,
          );
        }
        nativePhases.push({
          phase,
          rows: rows.length,
          missing_tuples: mismatched,
          verdict: mismatched > 0 ? 'rejected' : 'certified',
        });
      };
      await adapter.deleteNodesForFiles([...files]);
      await adapter.loadGraphToLbug(
        extractChangedSubgraph(graph, files),
        directory,
        directory,
        undefined,
        undefined,
        undefined,
        'none',
      );
      await audit('post-COPY');
      await adapter.tryFlushWAL();
      await audit('post-checkpoint');
      await adapter.closeLbug();
      await adapter.initLbug(join(directory, 'lbug'), { readOnly: true, skipFts: true });
      await audit('reopened');
      samples.sort((a, b) => a - b);
      results.push({
        nodes: size.nodes,
        queries: calls,
        min_ms: +samples[0].toFixed(3),
        median_ms: +samples[Math.floor(samples.length / 2)].toFixed(3),
        fingerprint: size.fingerprint,
        native_phases: nativePhases,
      });
    } finally {
      await adapter.closeLbug();
      await rm(directory, { recursive: true, force: true });
    }
  }
  const scaling =
    results[1].median_ms / results[0].median_ms / (results[1].nodes / results[0].nodes);
  const report = {
    node: process.version,
    platform: process.platform,
    cpu: cpus()[0].model,
    results,
    normalized_scaling: +scaling.toFixed(3),
    negative_controls: 'missing/swapped fields rejected',
    native_sequences:
      'selective delete/COPY, checkpoint and read-only reopen checked against independent tuple oracle',
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (process.argv.includes('--check'))
    assert.ok(
      scaling <= baseline.linear_scaling_budget,
      `normalized scaling ${scaling} exceeds ${baseline.linear_scaling_budget}`,
    );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
