import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertComparableRuntimes,
  assertCompletedCase,
  measureProcess,
  startProvider,
  summarizePairs,
} from './measure.mjs';

test('incomparable runtime filesystems or dependency bytes cannot produce paired evidence', () => {
  const baseline = {
    cli: { device: '1', filesystem: 'ext4' },
    nativeEntry: { device: '1', filesystem: 'ext4' },
    lockDigest: 'lock',
    nativeEntryDigest: 'native',
  };
  assertComparableRuntimes(baseline, structuredClone(baseline));
  const remote = structuredClone(baseline);
  remote.cli.device = '2';
  remote.cli.filesystem = 'v9fs';
  assert.throws(() => assertComparableRuntimes(baseline, remote), /different devices/);
  assert.throws(
    () => assertComparableRuntimes(baseline, { ...baseline, lockDigest: 'other' }),
    /lockfiles differ/,
  );
  assert.throws(
    () => assertComparableRuntimes(baseline, { ...baseline, nativeEntryDigest: 'other' }),
    /entry bytes differ/,
  );
});

test('completion checks reject a rebuilding no-op and an incomplete successful embedding run', () => {
  const metadata = { indexedAt: 'first', stats: { nodes: 10, embeddings: 5 } };
  assertCompletedCase('noop', metadata, metadata);
  assert.throws(
    () => assertCompletedCase('noop', { ...metadata, indexedAt: 'second' }, metadata),
    /No-op changed/,
  );
  assert.throws(
    () => assertCompletedCase('http-fresh', { ...metadata, embeddingJob: {} }),
    /pending/,
  );
  assert.throws(
    () => assertCompletedCase('http-resume', { ...metadata, embeddingCheckpoint: {} }),
    /pending/,
  );
  assert.throws(
    () => assertCompletedCase('http-fresh', { stats: { nodes: 10, embeddings: 0 } }),
    /no vectors/,
  );
});

test('paired evidence never treats small samples or equality as acceptance', () => {
  assert.equal(summarizePairs([{ baseline: 100, candidate: 90 }]).evidence, 'smoke-only');
  const equal = Array.from({ length: 7 }, () => ({ baseline: 100, candidate: 100 }));
  assert.equal(summarizePairs(equal).evidence, 'inconclusive');
  assert.equal(summarizePairs(equal.map((p) => ({ ...p, candidate: 110 }))).evidence, 'regression');
  assert.equal(
    summarizePairs(equal.map((p) => ({ ...p, candidate: 90 }))).evidence,
    'no-detected-regression',
  );
  assert.throws(() => summarizePairs([{ baseline: 0, candidate: 1 }]));
  assert.throws(() => summarizePairs([]));
});

test('process measurement waits for completion, records failure and preserves logs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'analyze-measure-test-'));
  try {
    const logFile = path.join(directory, 'child.log');
    const result = await measureProcess(
      process.execPath,
      ['-e', 'setTimeout(() => { console.log("finished"); process.exitCode = 7; }, 70)'],
      { cwd: directory, env: process.env, logFile, sampleMs: 10 },
    );
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, null);
    assert(result.elapsedMs >= 70);
    assert.equal((await fs.readFile(logFile, 'utf8')).trim(), 'finished');
    if (process.platform === 'linux') {
      assert(result.rssSamples > 0);
      assert(result.sampledPeakProcessTreeRssBytes > 0);
    }
    await assert.rejects(
      () =>
        measureProcess(process.execPath, ['-e', ''], {
          cwd: directory,
          env: process.env,
          logFile,
        }),
      { code: 'EEXIST' },
    );
    assert.equal((await fs.readFile(logFile, 'utf8')).trim(), 'finished');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('provider outage preserves paid-input accounting and deterministic vectors', async () => {
  const provider = await startProvider(16);
  const request = (input) =>
    fetch(`${provider.url}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
  try {
    const counters = provider.begin(2);
    const first = await (await request(['alpha', 'beta'])).json();
    const failure = await request(['gamma']);
    assert.equal(failure.status, 503);
    await failure.json();
    assert.equal(counters.acceptedInputs, 2);
    assert.equal(counters.rejectedRequests, 1);
    counters.failAfter = Infinity;
    const retry = await (await request(['alpha'])).json();
    assert.deepEqual(retry.data[0].embedding, first.data[0].embedding);
    assert.equal(counters.acceptedInputs, 3);
    assert.equal(counters.inputs.size, 2);
    assert.equal(counters.requests, 3);
  } finally {
    await provider.close();
  }
});
