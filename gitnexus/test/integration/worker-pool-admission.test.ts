import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { budgetHeapSizing } from '../../src/cli/analyze.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';

it.each(['execArgv', 'NODE_OPTIONS'] as const)(
  'reserves the real worker heap inherited from %s',
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
      expect(measured.workerMb).toBeLessThanOrEqual(resources.parse.workerHeapMb);
      const actualReservation =
        measured.mainMb * 1024 ** 2 +
        resources.headroomBytes +
        resources.supervisorBytes +
        resources.parse.graphPoolBytes +
        resources.parse.workers *
          (measured.workerMb * 1024 ** 2 + resources.parse.workerNativeBytes);
      expect(actualReservation).toBeLessThanOrEqual(resources.totalBytes);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  25000,
);
