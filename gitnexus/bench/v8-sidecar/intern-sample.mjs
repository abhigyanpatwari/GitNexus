import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';

const [modulePath, corpusPath, expectedStrings] = process.argv.slice(2);
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
// Heap sizing alone leaves background GC/JIT tasks and hash seeds variable.
// Keep their work in the measured thread under the same seed in both arms.
assert(process.execArgv.includes('--predictable'), 'Use deterministic GC/JIT scheduling');
assert(process.execArgv.includes('--predictable-gc-schedule'), 'Use the fixed GC profile');
const { internGraphStrings } = await import(pathToFileURL(modulePath).href);
const payloads = v8.deserialize(fs.readFileSync(corpusPath));
assert(Array.isArray(payloads) && payloads.length > 0, 'Empty corpus');

function measure() {
  global.gc();
  const pool = new Map();
  const graphs = [];
  let ms = 0;
  let cpuMs = 0;
  const totalCpu = process.cpuUsage();
  for (const payload of payloads) {
    const graph = v8.deserialize(payload);
    const cpu = process.cpuUsage();
    const started = performance.now();
    internGraphStrings(graph, pool);
    ms += performance.now() - started;
    const used = process.cpuUsage(cpu);
    cpuMs += (used.user + used.system) / 1000;
    graphs.push(graph);
  }
  const used = process.cpuUsage(totalCpu);
  assert.equal(pool.size, Number(expectedStrings));
  global.gc();
  const row = {
    ms,
    cpuMs,
    hydrateCpuMs: (used.user + used.system) / 1000,
    heapUsed: process.memoryUsage().heapUsed,
    peakRssKiB: process.resourceUsage().maxRSS,
  };
  assert.equal(graphs.length, payloads.length);
  return row;
}

// Warm this process's JIT before measuring. No graph, string pool, module
// instance or GC history from the other variant can enter this process.
measure();
measure();
console.log(
  JSON.stringify({
    ...measure(),
    pid: process.pid,
    warmupRounds: 2,
    execArgv: process.execArgv,
  }),
);
