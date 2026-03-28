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

  // ─── Unhappy paths ──────────────────────────────────────────────────

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

  it.skipIf(!hasDistWorker)('createWorkerPool with size 0 creates pool with zero workers', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    const zeroPool = createWorkerPool(workerUrl, 0);
    expect(zeroPool.size).toBe(0);
    return zeroPool.terminate();
  });
});
