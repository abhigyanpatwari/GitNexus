import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import { loadCachePayloads } from './cache-payloads.mjs';

const [baselineRoot, candidateRoot, indexingResults, output] = process.argv.slice(2);
assert(
  [baselineRoot, candidateRoot, indexingResults, output].every(Boolean),
  'Expected BASE_RUNTIME CANDIDATE_RUNTIME INDEXING_RESULTS OUTPUT',
);
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
const indexing = JSON.parse(fs.readFileSync(indexingResults, 'utf8'));
const storage = indexing.results.find((r) => r.name === 'baseline-seed')?.storagePath;
assert(storage, 'Missing baseline cache storage');
const runtimes = {};
const modules = {};
for (const [variant, root] of Object.entries({
  baseline: baselineRoot,
  candidate: candidateRoot,
})) {
  const filename = path.resolve(root, 'gitnexus/dist/storage/v8-sidecar.js');
  modules[variant] = await import(pathToFileURL(filename).href);
  runtimes[variant] = {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    moduleHash: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
  };
}
const { format: cacheFormat, payloads } = await loadCachePayloads(storage, {
  tryLoadV8Cache: modules.baseline.tryLoadV8Cache,
  // Older baseline runtimes need only their loose-shard reader.
  async loadPackedModules() {
    const load = (name) =>
      import(pathToFileURL(path.resolve(baselineRoot, `gitnexus/dist/storage/${name}.js`)).href);
    return { ...(await load('file-result-store')), ...(await load('file-result-codec')) };
  },
});
const pools = { baseline: new Map(), candidate: new Map() };
const fingerprint = createHash('sha256');
for (const payload of payloads) {
  fingerprint.update(payload);
  const before = v8.deserialize(payload);
  const after = v8.deserialize(payload);
  modules.baseline.internGraphStrings(before, pools.baseline);
  modules.candidate.internGraphStrings(after, pools.candidate);
  assert.deepEqual(after, before, 'Interned graphs differ');
  assert.deepEqual(v8.serialize(after), v8.serialize(before), 'Aliasing or bytes differ');
}
assert.deepEqual([...pools.candidate], [...pools.baseline], 'String pool order or contents differ');
const strings = pools.baseline.size;
assert(strings > 0, 'No strings were interned');
pools.baseline.clear();
pools.candidate.clear();
const samples = [];
// Correctness checks above retain a large graph and two module instances. Run
// each timed sample outside that heap, with identical startup/GC conditions.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-intern-'));
try {
  const corpusPath = path.join(scratch, 'payloads.v8');
  fs.writeFileSync(corpusPath, v8.serialize(payloads));
  for (let round = 0; round < 10; round++) {
    for (const variant of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const runtimeRoot = variant === 'baseline' ? baselineRoot : candidateRoot;
      const measured = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--expose-gc',
            '--predictable-gc-schedule',
            '--max-old-space-size=4096',
            fileURLToPath(new URL('./intern-sample.mjs', import.meta.url)),
            path.resolve(runtimeRoot, 'gitnexus/dist/storage/v8-sidecar.js'),
            corpusPath,
            String(strings),
          ],
          { encoding: 'utf8', timeout: 120_000 },
        ),
      );
      const row = { round, variant, ...measured };
      samples.push(row);
      console.log(JSON.stringify(row));
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      node: process.version,
      runtimes,
      corpusHead: indexing.head,
      cacheFormat,
      // One payload per legacy shard or packed facts/scope section.
      shards: payloads.length,
      bytes: payloads.reduce((sum, p) => sum + p.length, 0),
      fingerprint: fingerprint.digest('hex'),
      strings,
      warmupRounds: 2,
      equivalent: true,
      samples,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
