// Build the runtime, then: node --expose-gc --max-old-space-size=4096 memory.mjs CONFIG.json
// Config: { runtime, storage, output, count, width, mode: "seed"|"measure",
//           reader: "baseline"|"stream", iterations }. Each measurement is a fresh process.
// No forced GC between reads. Initial/final GC measure retained graph memory only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { runtime, storage, output, count, width = 0, mode, reader, iterations } = config;
assert(Number.isSafeInteger(count) && count >= 0);
assert(Number.isSafeInteger(width) && width >= 0);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(['seed', 'measure'].includes(mode));
assert(['baseline', 'stream'].includes(reader));
assert(global.gc, 'Run with --expose-gc');
const bufferPoolBytes = (mode === 'seed' ? 1024 : 512) * 1048576;
process.env.GITNEXUS_LBUG_BUFFER_POOL_SIZE = String(bufferPoolBytes);
process.env.GITNEXUS_SHARED_STORE = 'off';
process.env.GITNEXUS_HOME = path.join(path.dirname(output), 'home');
const source = (file) => import(pathToFileURL(path.join(runtime, 'gitnexus/dist', file)).href);
const { createKnowledgeGraph } = await source('core/graph/graph.js');
const { reconcileGraphNodeIdentities } = await source('core/incremental/write-reconciliation.js');
const adapter = await source('core/lbug/lbug-adapter.js');
const graph = createKnowledgeGraph();
const padding = 'x'.repeat(width);
const fingerprint = createHash('sha256');
let identityBytes = 0;
for (let i = 0; i < count; i++) {
  const index = String(i).padStart(7, '0');
  const id = `Function:node${index}${padding}`;
  const name = `fn${index}${padding}`;
  const filePath = `src/file${index}.ts${padding}`;
  const startLine = (i % 32) * 4;
  const endLine = startLine + 2;
  identityBytes += Buffer.byteLength(id) + Buffer.byteLength(name) + Buffer.byteLength(filePath);
  fingerprint.update(JSON.stringify([id, name, filePath, startLine, endLine]) + '\n');
  graph.addNode({ id, label: 'Function', properties: { name, filePath, startLine, endLine } });
}
const result = {
  config,
  node: process.version,
  driver: JSON.parse(
    fs.readFileSync(path.join(runtime, 'gitnexus/node_modules/@ladybugdb/core/package.json')),
  ).version,
  bufferPoolBytes,
  identityBytes,
  identityFingerprint: fingerprint.digest('hex'),
  iterations: [],
  completed: false,
};
let peakRss = 0,
  peakHeap = 0,
  currentPeakRss = 0,
  currentPeakHeap = 0;
function sample() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  currentPeakRss = Math.max(currentPeakRss, memory.rss);
  currentPeakHeap = Math.max(currentPeakHeap, memory.heapUsed);
  return memory;
}
function save() {
  result.peakRssBytes = Math.max(peakRss, process.resourceUsage().maxRSS * 1024);
  result.sampledPeakHeapBytes = peakHeap;
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
let timer;
try {
  await adapter.initLbug(path.join(storage, 'lbug'), { skipFts: true });
  if (mode === 'seed') {
    await adapter.loadGraphToLbug(graph, storage, storage, undefined, undefined, undefined, 'none');
    await adapter.tryFlushWAL();
  } else {
    global.gc();
    result.initial = sample();
    timer = setInterval(sample, 20);
    timer.unref();
    for (let i = 0; i < iterations; i++) {
      currentPeakRss = 0;
      currentPeakHeap = 0;
      const before = sample();
      let queries = 0;
      const readRows =
        reader === 'baseline'
          ? async (query) => {
              queries++;
              sample();
              const rows = await adapter.executeQuery(query);
              sample();
              return rows;
            }
          : async (query, visit) => {
              queries++;
              sample();
              await adapter.forEachQueryRow(query, visit);
              sample();
            };
      const start = performance.now();
      const receipt = await reconcileGraphNodeIdentities(graph, readRows, 'memory-scaling');
      const ms = performance.now() - start;
      assert.equal(receipt.nodes, count);
      assert.equal(queries, receipt.tables);
      const after = sample();
      result.iterations.push({
        i,
        ms,
        queries,
        verifiedNodes: receipt.nodes,
        before,
        after,
        peakRssBytes: currentPeakRss,
        sampledPeakHeapBytes: currentPeakHeap,
        maxRssKiB: process.resourceUsage().maxRSS,
      });
      save();
    }
    clearInterval(timer);
    global.gc();
    result.finalAfterGc = sample();
  }
  result.completed = true;
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await adapter.closeLbug();
  save();
}
console.log(
  JSON.stringify({
    count,
    width,
    reader,
    completed: result.completed,
    iterations: result.iterations.length,
    peakRssMiB: result.peakRssBytes / 1048576,
  }),
);
