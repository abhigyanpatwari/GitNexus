import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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
for (let round = 0; round < 10; round++) {
  for (const variant of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    global.gc();
    const pool = new Map();
    let ms = 0;
    let cpuMs = 0;
    const totalCpu = process.cpuUsage();
    const graphs = [];
    for (const payload of payloads) {
      const graph = v8.deserialize(payload);
      const cpu = process.cpuUsage();
      const started = performance.now();
      modules[variant].internGraphStrings(graph, pool);
      ms += performance.now() - started;
      const used = process.cpuUsage(cpu);
      cpuMs += (used.user + used.system) / 1000;
      graphs.push(graph);
    }
    const used = process.cpuUsage(totalCpu);
    assert.equal(pool.size, strings);
    global.gc();
    const row = {
      round,
      variant,
      ms,
      cpuMs,
      // Deserialization + interning CPU, excluding the forced heap-measurement GC.
      hydrateCpuMs: (used.user + used.system) / 1000,
      heapUsed: process.memoryUsage().heapUsed,
      peakRssKiB: process.resourceUsage().maxRSS,
    };
    assert.equal(graphs.length, payloads.length);
    samples.push(row);
    console.log(JSON.stringify(row));
  }
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
