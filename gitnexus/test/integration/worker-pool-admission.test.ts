import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { budgetHeapSizing } from '../../src/cli/analyze.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';

it.each(['execArgv', 'NODE_OPTIONS'] as const)(
  'admits the real main and worker heaps under flags from %s',
  (source) => {
    const resources = resolveAnalysisResourceBudget({
      effectiveMemoryBytes: 16384 * 1024 ** 2,
      availableCpus: 24,
      preferredWorkers: 16,
      mainHeapMb: 4348,
      modelMemoryMb: 0,
    });
    const sizing = budgetHeapSizing(resources.mainHeapMb);
    const flags = [
      `--max-old-space-size=${sizing.oldSpaceMb}`,
      `--max-semi-space-size=${sizing.semiSpaceMb}`,
    ];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-worker-admission-'));
    const worker = path.join(directory, 'heap-worker.cjs');
    fs.writeFileSync(
      worker,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', message => {
        if (message.type === 'sub-batch') {
          parentPort.postMessage({ type: 'progress', filesProcessed: message.files.length });
          parentPort.postMessage({ type: 'sub-batch-done' });
        }
        if (message.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: {
            heapMb: require('node:v8').getHeapStatistics().heap_size_limit / 1024 ** 2
          } });
        }
      });
      parentPort.postMessage({ type: 'ready' });
    `,
    );
    const factory = pathToFileURL(path.resolve('dist/core/ingestion/workers/worker-pool.js')).href;
    const runner = `
      import { createWorkerPool } from ${JSON.stringify(factory)};
      import { getHeapStatistics } from 'node:v8';
      const pool = createWorkerPool(new URL(${JSON.stringify(pathToFileURL(worker).href)}), ${resources.parse.workers}, { heapLimitMb: ${resources.parse.workerHeapMb} });
      try {
        const result = await pool.dispatch([{ path: 'a.ts', content: 'export const a = 1' }]);
        console.log(JSON.stringify({ mainMb: getHeapStatistics().heap_size_limit / 1024 ** 2, workerMb: result[0].heapMb }));
      } finally {
        await pool.terminate();
      }
    `;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (source === 'NODE_OPTIONS') env.NODE_OPTIONS = flags.join(' ');
    try {
      const output = execFileSync(
        process.execPath,
        [...(source === 'execArgv' ? flags : []), '--input-type=module', '--eval', runner],
        { env, encoding: 'utf8', timeout: 20000 },
      );
      const measured = JSON.parse(output) as { mainMb: number; workerMb: number };
      expect(measured.mainMb).toBe(resources.mainHeapMb);
      // The worker limit is its old-space cap plus a young generation that
      // the per-worker native allowance covers.
      expect(measured.workerMb * 1024 ** 2).toBeLessThanOrEqual(
        resources.parse.workerHeapMb * 1024 ** 2 + resources.parse.workerNativeBytes,
      );
      // Admission charges each worker its own cap, not the main heap.
      expect(resources.parse.workerHeapMb).toBeLessThan(resources.mainHeapMb);
      expect(measured.workerMb).toBeLessThan(measured.mainMb);
      const actualReservation =
        measured.mainMb * 1024 ** 2 +
        resources.headroomBytes +
        resources.supervisorBytes +
        resources.parse.graphPoolBytes +
        resources.parse.workers *
          (resources.parse.workerHeapMb * 1024 ** 2 + resources.parse.workerNativeBytes);
      expect(actualReservation).toBeLessThanOrEqual(resources.totalBytes);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  25000,
);

it.each(['execArgv', 'NODE_OPTIONS'] as const)(
  'enforces each parser worker heap cap under a main heap flag from %s',
  (source) => {
    const capMb = 512;
    // The analyze respawn sets both flags; each would override a worker limit.
    const flags = ['--max-old-space-size=3000', '--max-semi-space-size=128'];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-worker-cap-'));
    const reports = path.join(directory, 'limits.txt');
    const marker = path.join(directory, 'died');
    const worker = path.join(directory, 'cap-worker.cjs');
    // Every worker, replacements included, records the limit V8 gave it. The
    // first worker to receive a sub-batch exits so the pool spawns a replacement.
    fs.writeFileSync(
      worker,
      `
      const fs = require('node:fs');
      const { parentPort, threadId } = require('node:worker_threads');
      const heapMb = require('node:v8').getHeapStatistics().heap_size_limit / 1024 ** 2;
      fs.appendFileSync(${JSON.stringify(reports)}, threadId + ' ' + heapMb + '\\n');
      parentPort.on('message', message => {
        if (message.type === 'sub-batch') {
          try {
            fs.closeSync(fs.openSync(${JSON.stringify(marker)}, 'wx'));
            process.exit(1);
          } catch {}
          parentPort.postMessage({ type: 'progress', filesProcessed: message.files.length });
          parentPort.postMessage({ type: 'sub-batch-done' });
        }
        if (message.type === 'flush') parentPort.postMessage({ type: 'result', data: { heapMb } });
      });
      parentPort.postMessage({ type: 'ready' });
    `,
    );
    // A worker without its own limit, started after the pool, shows the
    // main limit was restored for everything else.
    const laterWorker = path.join(directory, 'later-worker.cjs');
    fs.writeFileSync(
      laterWorker,
      "require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit / 1024 ** 2);",
    );
    const factory = pathToFileURL(path.resolve('dist/core/ingestion/workers/worker-pool.js')).href;
    const runner = `
      import { createWorkerPool } from ${JSON.stringify(factory)};
      import { getHeapStatistics } from 'node:v8';
      import { Worker } from 'node:worker_threads';
      const limitMb = () => getHeapStatistics().heap_size_limit / 1024 ** 2;
      const mainBeforeMb = limitMb();
      const pool = createWorkerPool(new URL(${JSON.stringify(pathToFileURL(worker).href)}), 3, { heapLimitMb: ${capMb} });
      let slotGenerations;
      try {
        await pool.dispatch(Array.from({ length: 6 }, (_, i) => ({ path: 'f' + i + '.ts', content: 'export const a = ' + i })));
        slotGenerations = pool.getStats().slotGenerations;
      } finally {
        await pool.terminate();
      }
      const later = new Worker(new URL(${JSON.stringify(pathToFileURL(laterWorker).href)}));
      const laterMb = await new Promise((resolve) => later.once('message', resolve));
      await later.terminate();
      console.log(JSON.stringify({ mainBeforeMb, mainAfterMb: limitMb(), laterMb, slotGenerations }));
    `;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (source === 'NODE_OPTIONS') env.NODE_OPTIONS = flags.join(' ');
    try {
      const output = execFileSync(
        process.execPath,
        [...(source === 'execArgv' ? flags : []), '--input-type=module', '--eval', runner],
        { env, encoding: 'utf8', timeout: 20000 },
      );
      const measured = JSON.parse(output.trim().split('\n').at(-1) ?? '') as {
        mainBeforeMb: number;
        mainAfterMb: number;
        laterMb: number;
        slotGenerations: number[];
      };
      const workerMb = fs
        .readFileSync(reports, 'utf8')
        .trim()
        .split('\n')
        .map((line) => Number(line.split(' ')[1]));
      expect(measured.mainBeforeMb).toBeGreaterThan(3000);
      expect(measured.slotGenerations.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(1);
      // Three initial workers plus at least one replacement.
      expect(workerMb.length).toBeGreaterThanOrEqual(4);
      for (const mb of workerMb) {
        // Old space plus the young generation, which the native allowance covers.
        expect(mb).toBeLessThanOrEqual(capMb + 128);
        expect(mb).toBeLessThan(measured.mainBeforeMb);
      }
      expect(measured.mainAfterMb).toBe(measured.mainBeforeMb);
      expect(measured.laterMb).toBe(measured.mainBeforeMb);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  25000,
);
