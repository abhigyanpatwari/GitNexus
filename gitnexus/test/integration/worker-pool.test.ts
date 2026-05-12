/**
 * Integration Tests: Worker Pool & Parse Worker
 *
 * Verifies that the worker pool can spawn real worker threads using the
 * compiled dist/ parse-worker.js and process files correctly.
 * This is critical for cross-platform CI where vitest runs from src/
 * but workers need compiled .js files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createWorkerPool, WorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { _captureLogger } from '../../src/core/logger.js';
const DIST_WORKER = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'core',
  'ingestion',
  'workers',
  'parse-worker.js',
);
const hasDistWorker = fs.existsSync(DIST_WORKER);

function writeTempWorker(prefix: string, source: string): { tempDir: string; workerPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workerPath = path.join(tempDir, 'worker.js');
  fs.writeFileSync(workerPath, source);
  return { tempDir, workerPath };
}

describe('worker pool integration', () => {
  let pool: WorkerPool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.terminate();
      pool = undefined;
    }
  });

  it.skipIf(!hasDistWorker)('creates a worker pool from dist/ worker', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    expect(pool.size).toBe(1);
  });

  it.skipIf(!hasDistWorker)('dispatches an empty batch without error', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    const results = await pool.dispatch([]);
    expect(results).toEqual([]);
  });

  it.skipIf(!hasDistWorker)('parses a single TypeScript file through worker', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const fixtureFile = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'mini-repo',
      'src',
      'validator.ts',
    );
    const content = fs.readFileSync(fixtureFile, 'utf-8');

    const results = await pool.dispatch<any, any>([{ path: 'src/validator.ts', content }]);

    // Worker returns an array of results (one per worker chunk)
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.fileCount).toBe(1);
    expect(result.nodes.length).toBeGreaterThan(0);

    // Should find the validateInput function
    const names = result.nodes.map((n: any) => n.properties.name);
    expect(names).toContain('validateInput');
  });

  it.skipIf(!hasDistWorker)('parses multiple files across workers', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2);

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    expect(files.length).toBeGreaterThanOrEqual(4);

    const results = await pool.dispatch<any, any>(files);

    // Each worker chunk returns a result
    expect(results.length).toBeGreaterThan(0);

    // Total files parsed should match input
    const totalParsed = results.reduce((sum: number, r: any) => sum + r.fileCount, 0);
    expect(totalParsed).toBe(files.length);

    // Should find symbols from multiple files
    const allNames = results.flatMap((r: any) => r.nodes.map((n: any) => n.properties.name));
    expect(allNames).toContain('handleRequest');
    expect(allNames).toContain('validateInput');
    expect(allNames).toContain('saveToDb');
    expect(allNames).toContain('formatResponse');
  });

  it.skipIf(!hasDistWorker)('reports progress during parsing', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    const progressCalls: number[] = [];
    await pool.dispatch<any, any>(files, (filesProcessed) => {
      progressCalls.push(filesProcessed);
    });

    // Progress callbacks are best-effort — with a small batch the worker may
    // process all files before the progress message is delivered. Just verify
    // that if progress was reported, the values are sensible.
    if (progressCalls.length > 0) {
      expect(progressCalls[progressCalls.length - 1]).toBe(files.length);
    }
  });

  it.skipIf(!hasDistWorker)('terminates cleanly', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2);
    await pool.terminate();
    pool = undefined; // already terminated
  });

  it('fails gracefully with invalid worker path', () => {
    const badUrl = pathToFileURL('/nonexistent/worker.js') as URL;
    // createWorkerPool validates the worker script exists before spawning
    expect(() => {
      pool = createWorkerPool(badUrl, 1);
    }).toThrow(/Worker script not found/);
  });

  // --- Unhappy paths -----------------------------------------------------

  it.skipIf(!hasDistWorker)('dispatch after terminate rejects', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    const terminatedPool = pool;
    await terminatedPool.terminate();
    pool = undefined; // already terminated — prevent afterEach double-terminate

    await expect(
      terminatedPool.dispatch([{ path: 'x.ts', content: 'const x = 1;' }]),
    ).rejects.toThrow();
  });

  it.skipIf(!hasDistWorker)('double terminate does not throw', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1);
    await pool.terminate();
    await expect(pool.terminate()).resolves.toBeUndefined();
    pool = undefined;
  });

  it.skipIf(!hasDistWorker)(
    'dispatches entries with empty content string without crashing',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1);

      const results = await pool.dispatch<any, any>([{ path: 'empty.ts', content: '' }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(typeof result.fileCount).toBe('number');
      expect(result.fileCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.nodes)).toBe(true);
    },
  );

  it('treats warning messages as non-terminal and still resolves the worker result', async () => {
    const { tempDir, workerPath } = writeTempWorker(
      'gitnexus-worker-warning-',
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({ type: 'warning', message: 'warning before result' });
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { nodes: [], relationships: [], symbols: [], imports: [], calls: [], heritage: [], routes: [], fileCount: 1 } });
        }
      });
    `,
    );

    const cap = _captureLogger();
    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1);

    try {
      const results = await pool.dispatch<any, any>([
        { path: 'warning.ts', content: 'const x = 1;' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].fileCount).toBe(1);
      expect(cap.records().some((r) => r.msg === 'warning before result')).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps a slow sub-batch alive when the worker reports progress', async () => {
    const { tempDir, workerPath } = writeTempWorker(
      'gitnexus-worker-progress-',
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          let processed = 1;
          parentPort.postMessage({ type: 'progress', filesProcessed: processed });
          const timer = setInterval(() => {
            processed++;
            parentPort.postMessage({ type: 'progress', filesProcessed: processed });
            if (processed === 4) {
              clearInterval(timer);
              parentPort.postMessage({ type: 'sub-batch-done' });
            }
          }, 120);
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { fileCount: 4 } });
        }
      });
    `,
    );

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 500,
      maxTimeoutRetries: 0,
    });

    try {
      const progressCalls: number[] = [];
      const results = await pool.dispatch<any, any>(
        Array.from({ length: 4 }, (_, i) => ({ path: `slow-${i}.ts`, content: '' })),
        (filesProcessed) => progressCalls.push(filesProcessed),
      );
      expect(results).toEqual([{ fileCount: 4 }]);
      expect(progressCalls).toEqual([1, 2, 3, 4]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('replaces a timed-out worker and retries with a longer timeout', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-retry-'));
    const markerPath = path.join(tempDir, 'first-attempt.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          if (!fs.existsSync(markerPath)) {
            fs.writeFileSync(markerPath, 'timed out once');
            return;
          }
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { fileCount: 1, recovered: true } });
        }
      });
    `,
    );

    const cap = _captureLogger();
    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 500,
      maxTimeoutRetries: 1,
      timeoutBackoffFactor: 4,
    });

    try {
      const results = await pool.dispatch<any, any>([{ path: 'retry.ts', content: '' }]);
      expect(results).toEqual([{ fileCount: 1, recovered: true }]);
      // 500ms idle timeout × 4 backoff factor = 2000ms = "2s" in the retry log.
      expect(
        cap.records().some((r) => String(r.msg ?? '').includes('Retrying with 2s timeout')),
      ).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects dispatch when replacement worker crashes during startup', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-replace-fail-'));
    const markerPath = path.join(tempDir, 'first-attempt.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      if (fs.existsSync(markerPath)) {
        throw new Error('simulated startup crash');
      }
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          fs.writeFileSync(markerPath, 'stalled');
          return;
        }
      });
    `,
    );

    // Capture pino output AND assert on it: the worker pool should emit a
    // warn-level record naming the crash before rejecting, so an operator
    // can tell a startup-crash from a stalled-worker rejection. Asserting
    // here keeps coverage parity with the prior console.warn spy version.
    const cap = _captureLogger();
    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 150,
      maxTimeoutRetries: 1,
      timeoutBackoffFactor: 4,
    });

    try {
      await expect(pool.dispatch<any, any>([{ path: 'crash.ts', content: '' }])).rejects.toThrow(
        /simulated startup crash|exited with code|idle timeout/,
      );
      const warnRecords = cap.records().filter((r) => Number(r.level) >= 40 /* warn or above */);
      expect(warnRecords.length).toBeGreaterThan(0);
    } finally {
      cap.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves global path order across split-and-retry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-split-'));
    const markerPath = path.join(tempDir, 'stalled-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      let current = [];
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((file) => file.path);
          if (current.includes('stall.ts') && current.length > 1 && !fs.existsSync(markerPath)) {
            fs.writeFileSync(markerPath, 'split this job');
            return;
          }
          parentPort.postMessage({ type: 'progress', filesProcessed: current.length });
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { fileCount: current.length, paths: current } });
        }
      });
    `,
    );

    const cap = _captureLogger();
    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchSize: 2,
      subBatchIdleTimeoutMs: 150,
      maxTimeoutRetries: 0,
      timeoutBackoffFactor: 3,
    });

    try {
      const progressCalls: number[] = [];
      const results = await pool.dispatch<any, any>(
        [
          { path: 'first.ts', content: '' },
          { path: 'second.ts', content: '' },
          { path: 'stall.ts', content: '' },
          { path: 'after.ts', content: '' },
        ],
        (filesProcessed) => progressCalls.push(filesProcessed),
      );

      expect(results.flatMap((result) => result.paths)).toEqual([
        'first.ts',
        'second.ts',
        'stall.ts',
        'after.ts',
      ]);
      expect(progressCalls).toEqual([...progressCalls].sort((a, b) => a - b));
      expect(progressCalls.at(-1)).toBe(4);
      expect(
        cap.records().some((r) => String(r.msg ?? '').includes('Splitting into 1/1 item jobs')),
      ).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a persistently stalled singleton so the caller can fall back sequentially', async () => {
    const { tempDir, workerPath } = writeTempWorker(
      'gitnexus-worker-stalled-',
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') return;
      });
    `,
    );

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 150,
      maxTimeoutRetries: 0,
    });

    try {
      await expect(pool.dispatch<any, any>([{ path: 'stalled.ts', content: '' }])).rejects.toThrow(
        /sequential fallback/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not resolve early when a stalled peer job is requeued during another worker finish', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-race-'));
    const markerPath = path.join(tempDir, 'stalled-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      let current = [];
      function finish() {
        parentPort.postMessage({ type: 'progress', filesProcessed: current.length });
        parentPort.postMessage({ type: 'sub-batch-done' });
      }
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((file) => file.path);
          if (current.includes('stall-a.ts') && current.length > 1 && !fs.existsSync(markerPath)) {
            fs.writeFileSync(markerPath, 'stall the second job once');
            return;
          }
          if (current.includes('tail-a.ts')) {
            setTimeout(finish, 180);
            return;
          }
          finish();
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { fileCount: current.length, paths: current } });
        }
      });
    `,
    );

    const cap = _captureLogger();
    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 2, {
      subBatchSize: 2,
      subBatchIdleTimeoutMs: 150,
      maxTimeoutRetries: 0,
      timeoutBackoffFactor: 3,
    });

    try {
      const results = await pool.dispatch<any, any>([
        { path: 'first-a.ts', content: '' },
        { path: 'first-b.ts', content: '' },
        { path: 'stall-a.ts', content: '' },
        { path: 'stall-b.ts', content: '' },
        { path: 'tail-a.ts', content: '' },
        { path: 'tail-b.ts', content: '' },
      ]);

      expect(results.flatMap((result) => result.paths)).toEqual([
        'first-a.ts',
        'first-b.ts',
        'stall-a.ts',
        'stall-b.ts',
        'tail-a.ts',
        'tail-b.ts',
      ]);
      expect(
        cap.records().some((r) => String(r.msg ?? '').includes('Splitting into 1/1 item jobs')),
      ).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('completes split-and-retry when the timed-out worker is the only active worker', async () => {
    // Regression test for: the split-and-retry path resolving early when no other
    // workers are active (activeWorkers === 0 during await replaceWorker).
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-sole-active-'));
    const markerPath = path.join(tempDir, 'stalled-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      let current = [];
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((file) => file.path);
          if (current.length > 1 && !fs.existsSync(markerPath)) {
            fs.writeFileSync(markerPath, 'stall once');
            return;
          }
          parentPort.postMessage({ type: 'progress', filesProcessed: current.length });
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { fileCount: current.length, paths: current } });
        }
      });
    `,
    );

    const cap = _captureLogger();
    // 2 workers but subBatchSize=4 means all 4 items form 1 job; second worker stays idle.
    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 2, {
      subBatchSize: 4,
      subBatchIdleTimeoutMs: 300,
      maxTimeoutRetries: 0,
      timeoutBackoffFactor: 3,
    });

    try {
      const results = await pool.dispatch<any, any>([
        { path: 'a.ts', content: '' },
        { path: 'b.ts', content: '' },
        { path: 'c.ts', content: '' },
        { path: 'd.ts', content: '' },
      ]);

      const allPaths = results.flatMap((r: any) => r.paths);
      expect(allPaths.sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
      expect(cap.records().some((r) => String(r.msg ?? '').includes('Splitting into'))).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('fails fast on a result message that violates the worker protocol', async () => {
    const { tempDir, workerPath } = writeTempWorker(
      'gitnexus-worker-protocol-',
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({ type: 'result', data: { fileCount: 1 } });
        }
      });
    `,
    );

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 100,
    });

    try {
      await expect(pool.dispatch<any, any>([{ path: 'bad.ts', content: '' }])).rejects.toThrow(
        /protocol error/,
      );
      await expect(pool.dispatch<any, any>([{ path: 'after.ts', content: '' }])).rejects.toThrow(
        /previous failure.*protocol error/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds worker jobs by byte budget as well as file count', async () => {
    const { tempDir, workerPath } = writeTempWorker(
      'gitnexus-worker-byte-budget-',
      `
      const { parentPort } = require('node:worker_threads');
      let current = [];
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((file) => file.path);
          parentPort.postMessage({ type: 'progress', filesProcessed: current.length });
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { paths: current } });
        }
      });
    `,
    );

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchSize: 10,
      subBatchMaxBytes: 6,
      subBatchIdleTimeoutMs: 100,
    });

    try {
      const results = await pool.dispatch<any, any>([
        { path: 'a.ts', content: '1234' },
        { path: 'b.ts', content: '5678' },
        { path: 'c.ts', content: '90' },
      ]);
      expect(results.map((result) => result.paths)).toEqual([['a.ts'], ['b.ts', 'c.ts']]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasDistWorker)('createWorkerPool with size 0 creates pool with zero workers', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    const zeroPool = createWorkerPool(workerUrl, 0);
    expect(zeroPool.size).toBe(0);
    return zeroPool.terminate();
  });

  it.skipIf(!hasDistWorker)('dispatch with size 0 rejects clearly', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    const zeroPool = createWorkerPool(workerUrl, 0);
    try {
      await expect(zeroPool.dispatch([{ path: 'x.ts', content: 'const x = 1;' }])).rejects.toThrow(
        /no active workers/,
      );
    } finally {
      await zeroPool.terminate();
    }
  });
});
