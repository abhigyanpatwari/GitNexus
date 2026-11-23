#!/usr/bin/env node
/** Measure a cold publication of GitNexus's own source with either built runtime. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runBenchmarkTool } from '../lib/benchmark-tools.mjs';
import { fingerprintIds } from '../lib/identity-guard.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({
  options: {
    ref: { type: 'string' },
    root: { type: 'string', default: path.join(repository, 'gitnexus') },
  },
});
assert.ok(
  values.ref,
  'usage: node bench/typescript-ingestion/measure-index.mjs --ref SHA [--root BUILT-PACKAGE]',
);
const root = path.resolve(values.root);
const revParse = (cwd, ref) =>
  runBenchmarkTool('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd,
    encoding: 'utf8',
  }).trim();
const sourceCommit = revParse(repository, values.ref);
const archive = runBenchmarkTool(
  'git',
  [
    'archive',
    sourceCommit,
    '--',
    'gitnexus/src',
    'gitnexus/tsconfig.json',
    'gitnexus/package.json',
    'gitnexus-shared/src',
    'gitnexus-shared/package.json',
  ],
  { cwd: repository, maxBuffer: 32 * 1024 * 1024 },
);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ts-index-bench-'));
try {
  const source = fs.mkdirSync(path.join(temporary, 'source'), { recursive: true });
  runBenchmarkTool('tar', ['-xf', '-', '-C', source], { input: archive });
  process.env.GITNEXUS_HOME = path.join(temporary, 'home');
  process.env.GITNEXUS_STORAGE_PATH = path.join(temporary, 'index');
  const workerPoolSize = 2;
  const { runFullAnalysis } = await import(
    pathToFileURL(path.join(root, 'dist/core/run-analyze.js'))
  );
  const started = performance.now();
  const result = await runFullAnalysis(
    source,
    {
      force: true,
      skipGit: true,
      skipFts: true,
      skipAgentsMd: true,
      skipSkills: true,
      embeddings: false,
      useParseCache: false,
      workerPoolSize,
    },
    { onProgress() {} },
  );
  const publicationMs = performance.now() - started;
  assert.equal(result.alreadyUpToDate, undefined);
  assert.equal(result.graphWriteCollapsed, undefined);
  const pipeline = result.pipelineResult;
  assert.ok(pipeline?.usedWorkerPool && pipeline.reparsedFileCount > 0);
  assert.deepEqual(pipeline.scopeExtractionFailures ?? [], []);

  const { Database, Connection } = createRequire(path.join(root, 'package.json'))(
    '@ladybugdb/core',
  );
  const db = new Database(
    path.join(result.storagePath, 'lbug'),
    256 * 1024 * 1024,
    false,
    true,
    1024 ** 3,
  );
  const connection = new Connection(db);
  let persistedFiles;
  const calls = [];
  try {
    const rows = await (await connection.query('MATCH (f:File) RETURN count(f) AS files')).getAll();
    persistedFiles = Number(rows[0].files);
    assert.equal(persistedFiles, result.stats.files);
    // Concrete labels keep the native readback from planning every schema pair.
    for (const caller of ['Function', 'Method']) {
      for (const callee of ['Function', 'Method']) {
        const callRows = await (
          await connection.query(
            `MATCH (a:${caller})-[r:CodeRelation {type: 'CALLS'}]->(b:${callee}) RETURN a.id AS source, b.id AS target, r.reason AS reason`,
          )
        ).getAll();
        for (const { source, target, reason } of callRows) {
          calls.push(JSON.stringify([source, target, reason]));
        }
      }
    }
    assert.ok(calls.length > 0);
  } finally {
    await connection.close();
    await db.close();
  }
  console.log(
    'TS_INDEX_RESULT ' +
      JSON.stringify({
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        revision: revParse(root, 'HEAD'),
        sourceCommit,
        sourceFingerprint: createHash('sha256').update(archive).digest('hex'),
        workerPoolSize,
        publicationMs,
        peakRssKiB: process.resourceUsage().maxRSS,
        reparsedFiles: pipeline.reparsedFileCount,
        persistedFiles,
        stats: result.stats,
        functionAndMethodCallEdges: calls.length,
        functionAndMethodCallFingerprint: fingerprintIds(calls),
      }),
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
