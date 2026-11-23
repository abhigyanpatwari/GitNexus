import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';

export function measure(payloads, internGraphStrings, expectedStrings) {
  global.gc();
  const pool = new Map();
  const graphs = [];
  let ms = 0;
  let cpuMs = 0;
  let hydrateCpuMs = 0;
  for (const payload of payloads) {
    const hydrateCpu = process.cpuUsage();
    const graph = v8.deserialize(payload);
    const hydrated = process.cpuUsage(hydrateCpu);
    hydrateCpuMs += (hydrated.user + hydrated.system) / 1000;
    const cpu = process.cpuUsage();
    const started = performance.now();
    internGraphStrings(graph, pool);
    ms += performance.now() - started;
    const used = process.cpuUsage(cpu);
    cpuMs += (used.user + used.system) / 1000;
    graphs.push(graph);
  }
  assert.equal(pool.size, Number(expectedStrings));
  global.gc();
  const row = {
    ms,
    cpuMs,
    hydrateCpuMs,
    heapUsed: process.memoryUsage().heapUsed,
    peakRssKiB: process.resourceUsage().maxRSS,
  };
  assert.equal(graphs.length, payloads.length);
  return row;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [modulePath, corpusPath, expectedStrings] = process.argv.slice(2);
  assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
  // Keep background GC/JIT work and hash seeds the same in both arms.
  assert(process.execArgv.includes('--predictable'), 'Use deterministic GC/JIT scheduling');
  assert(process.execArgv.includes('--predictable-gc-schedule'), 'Use the fixed GC profile');
  const { internGraphStrings } = await import(pathToFileURL(modulePath).href);
  const payloads = v8.deserialize(fs.readFileSync(corpusPath));
  assert(Array.isArray(payloads) && payloads.length > 0, 'Empty corpus');
  // Warm this process's JIT before measuring, without sharing either arm's state.
  measure(payloads, internGraphStrings, expectedStrings);
  measure(payloads, internGraphStrings, expectedStrings);
  console.log(
    JSON.stringify({
      ...measure(payloads, internGraphStrings, expectedStrings),
      pid: process.pid,
      warmupRounds: 2,
      execArgv: process.execArgv,
    }),
  );
}
