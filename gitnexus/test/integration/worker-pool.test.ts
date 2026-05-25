/**
 * Integration Tests: Worker Pool & Parse Worker
 *
 * Verifies that the worker pool can spawn real worker threads using the
 * compiled dist/ parse-worker.js and process files correctly.
 * This is critical for cross-platform CI where vitest runs from src/
 * but workers need compiled .js files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createWorkerPool,
  WorkerPool,
  WorkerPoolDispatchError,
} from '../../src/core/ingestion/workers/worker-pool.js';
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

// Prepend two things to every ad-hoc test worker source:
//
//   1. The ready handshake so the pool's `waitForWorkerReady` resolves
//      immediately for replacement spawns. Production `parse-worker.ts`
//      emits the same handshake at top-of-script before installing its
//      message handler. Without it, every test that triggers a
//      replacement (worker crash + recover) would hit the 5s
//      WORKER_READY_TIMEOUT_MS and fail with "Replacement worker startup
//      failed and no slots remain".
//
//   2. A `parentPort.on('message', ...)` wrapper that converts the
//      sub-batch `files[i].content` field from `Uint8Array`
//      (transferred zero-copy by the pool) back to `string` for the
//      ad-hoc test worker scripts. Production `parse-worker.ts` does
//      this lazily at the tree-sitter call site; test scripts assume
//      `msg.files[i].content` is already a string. Without this
//      conversion, the test scripts would need to decode each content
//      Uint8Array themselves.
const READY_PREAMBLE = `
const { parentPort: __pp } = require('node:worker_threads');
const __decoder = new TextDecoder('utf-8');
const __decodeFrame = (raw) => {
  if (
    raw && typeof raw === 'object' &&
    raw.type === 'sub-batch' &&
    Array.isArray(raw.files)
  ) {
    return {
      type: 'sub-batch',
      files: raw.files.map((f) => ({
        path: f.path,
        content: typeof f.content === 'string' ? f.content : __decoder.decode(f.content),
      })),
    };
  }
  return raw;
};
const __origOn = __pp.on.bind(__pp);
__pp.on = (event, handler) => {
  if (event !== 'message') return __origOn(event, handler);
  return __origOn(event, (raw) => handler(__decodeFrame(raw)));
};
__pp.postMessage({ type: 'ready' });
`;

function writeReadyWorker(workerPath: string, source: string): void {
  fs.writeFileSync(workerPath, READY_PREAMBLE + source);
}

function writeTempWorker(prefix: string, source: string): { tempDir: string; workerPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workerPath = path.join(tempDir, 'worker.js');
  writeReadyWorker(workerPath, source);
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
    // Stronger than `nodes.length > 0`: the file MUST emit the
    // validateInput function symbol or the parse is broken.
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

    // mini-repo/src/ ships exactly 7 .ts files (db, formatter, handler,
    // index, logger, middleware, validator). Pinning the count surfaces
    // a fixture change as a test signal instead of letting the rest of
    // the test silently rebalance.
    expect(files.length).toBe(7);

    const results = await pool.dispatch<any, any>(files);

    // All 7 files fit one default sub-batch (size 200 / budget 8MB),
    // so the dispatch returns exactly one chunk result regardless of
    // pool size.
    expect(results).toHaveLength(1);

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
      // Empty content → tree-sitter parse produces no symbols. The
      // fileCount on the result reflects how many files the worker
      // successfully processed (1 in this case — an empty file is still
      // "processed", just without emitting symbols). Pinning exactly 1
      // catches a regression that would silently start dropping
      // empty-content files from the count.
      expect(result.fileCount).toBe(1);
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
    writeReadyWorker(
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
    writeReadyWorker(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      if (fs.existsSync(markerPath)) {
        process.exit(1);
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
      // Resilience refactor (PR #1693): even with a startup-crashing
      // replacement worker, Node's `online` event fires BEFORE the
      // worker's main script runs — `waitForWorkerOnline` resolves
      // optimistically, the slot is re-occupied with a doomed worker,
      // the second idle timeout triggers the give-up path, and the
      // file is quarantined. Dispatch resolves with empty results and
      // the file is in quarantine. A warning is still emitted for the
      // operator. Documented race: `waitForWorkerOnline` does not wait
      // for a grace period after `online` before resolving.
      const results = await pool.dispatch<any, any>([{ path: 'crash.ts', content: '' }]);
      expect(results).toEqual([]);
      expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['crash.ts']);
      const warnRecords = cap.records().filter((r) => Number(r.level) >= 40 /* warn or above */);
      // The pool must emit at least one warn naming the crash recovery
      // path so an operator can distinguish a startup-crash from a
      // stalled-worker rejection. Content match is stronger than a
      // length bound: a future refactor that drops the warning would
      // pass a length check but fail this predicate.
      const sawRecoveryWarn = warnRecords.some(
        (r) =>
          typeof r.msg === 'string' &&
          /(respawn|dropping slot|replacement|did not report ready|exceeded respawn)/i.test(r.msg),
      );
      expect(sawRecoveryWarn).toBe(true);
    } finally {
      cap.restore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves global path order across split-and-retry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-split-'));
    const markerPath = path.join(tempDir, 'stalled-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    writeReadyWorker(
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

  it('quarantines a persistently stalled singleton so subsequent dispatches skip it', async () => {
    // Resilience refactor (PR #1693): a singleton-timeout no longer
    // rejects the whole dispatch. The stalled file is quarantined and
    // the slot respawns; the dispatch resolves with empty results (no
    // files parsed). Subsequent dispatches with the same path filter it
    // out via the pool's quarantine.
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
      consecutiveFailureThreshold: 10,
      maxRespawnsPerSlot: 3,
    });

    try {
      const results = await pool.dispatch<any, any>([{ path: 'stalled.ts', content: '' }]);
      expect(results).toEqual([]);
      expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['stalled.ts']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not resolve early when a stalled peer job is requeued during another worker finish', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-race-'));
    const markerPath = path.join(tempDir, 'stalled-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    writeReadyWorker(
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
    writeReadyWorker(
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
      // Resilience refactor (PR #1693): subsequent dispatches reject with
      // the circuit-breaker message instead of the prior-failure wording.
      await expect(pool.dispatch<any, any>([{ path: 'after.ts', content: '' }])).rejects.toThrow(
        /circuit breaker.*protocol error/i,
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

  // --- Resilience layers (PR #1693 follow-on) ----------------------------

  it('respawns the slot after worker process.exit and finishes the work on the replacement', async () => {
    // Worker exits with code 1 on its first sub-batch, then the replacement
    // processes whatever lands in its sub-batch successfully. Exercises
    // Layer 1 auto-respawn + Layer 3 quarantine end-to-end through real
    // worker IPC and real waitForWorkerOnline timing.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resilience-respawn-'));
    const markerPath = path.join(tempDir, 'crashed-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    writeReadyWorker(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      let current = [];
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((file) => file.path);
          if (!fs.existsSync(markerPath)) {
            fs.writeFileSync(markerPath, 'crash once');
            parentPort.postMessage({ type: 'starting-file', path: current[0] });
            process.exit(134);
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

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 2000,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 3,
    });

    try {
      const results = await pool.dispatch<
        { path: string; content: string },
        { fileCount: number; paths: string[] }
      >([
        { path: 'killer.ts', content: '' },
        { path: 'good.ts', content: '' },
      ]);
      // killer.ts was quarantined; replacement processes only the
      // non-quarantined remainder.
      expect(results.length).toBe(1);
      expect(results[0].paths).toEqual(['good.ts']);
      expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['killer.ts']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('attributes exactly via authoritative starting-file message on worker crash', async () => {
    // Worker emits starting-file for the SECOND file, then crashes. The
    // pool must quarantine exactly that file (not items[0] from the
    // heuristic). Validates Layer 4 end-to-end through real IPC ordering.
    const { tempDir, workerPath } = writeTempWorker(
      'gitnexus-resilience-attribution-',
      `
      const { parentPort } = require('node:worker_threads');
      let current = [];
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((file) => file.path);
          // Pretend we successfully processed the first file, then crash
          // mid-second.
          parentPort.postMessage({ type: 'starting-file', path: current[0] });
          parentPort.postMessage({ type: 'progress', filesProcessed: 1 });
          parentPort.postMessage({ type: 'starting-file', path: current[1] });
          process.exit(134);
        }
      });
    `,
    );

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 2000,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 1,
    });

    try {
      // Job dies, respawn re-tries with filtered job (without items[1]
      // and items[0] since items[0] was already processed but flush
      // never landed). Second worker crashes on items[0] of the
      // re-queued job (which is the original items[0]); slot drops
      // after budget=1 exceeded.
      await expect(
        pool.dispatch<{ path: string; content: string }, unknown>([
          { path: 'first.ts', content: '' },
          { path: 'second-mid-crash.ts', content: '' },
          { path: 'third.ts', content: '' },
        ]),
      ).rejects.toBeInstanceOf(WorkerPoolDispatchError);
      // The crash attribution names the file authoritatively from the
      // starting-file message, not items[0].
      const quarantine = pool.getQuarantinedPaths?.() ?? [];
      expect(quarantine).toContain('second-mid-crash.ts');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('quarantine filters subsequent dispatches without sending to a worker', async () => {
    // After dispatch A quarantines path X, dispatch B with X in input
    // must NOT include X in the sub-batch the worker receives. Records
    // the paths each sub-batch sees.
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gitnexus-resilience-quarantine-filter-'),
    );
    const seenPath = path.join(tempDir, 'sub-batches.json');
    const markerPath = path.join(tempDir, 'crashed-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    writeReadyWorker(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const seenPath = ${JSON.stringify(seenPath)};
      const markerPath = ${JSON.stringify(markerPath)};
      let current = [];
      function recordSeen(paths) {
        const prior = fs.existsSync(seenPath) ? JSON.parse(fs.readFileSync(seenPath, 'utf-8')) : [];
        prior.push(paths);
        fs.writeFileSync(seenPath, JSON.stringify(prior));
      }
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((f) => f.path);
          recordSeen(current);
          if (!fs.existsSync(markerPath) && current.includes('poison.ts')) {
            fs.writeFileSync(markerPath, 'crash once on poison');
            parentPort.postMessage({ type: 'starting-file', path: 'poison.ts' });
            process.exit(134);
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

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 2000,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 3,
    });

    try {
      // Dispatch A quarantines poison.ts.
      await pool.dispatch<{ path: string; content: string }, unknown>([
        { path: 'poison.ts', content: '' },
        { path: 'companion.ts', content: '' },
      ]);
      expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['poison.ts']);

      // Dispatch B includes poison.ts; pool must filter it out before
      // the worker sees it.
      const results = await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
        { path: 'poison.ts', content: '' },
        { path: 'fresh.ts', content: '' },
      ]);
      expect(results.length).toBe(1);
      expect(results[0].paths).toEqual(['fresh.ts']);

      // Audit: which sub-batches did the worker actually receive?
      const allSubBatches: string[][] = JSON.parse(fs.readFileSync(seenPath, 'utf-8'));
      const dispatchBSubBatches = allSubBatches.slice(-1);
      expect(dispatchBSubBatches[0]).toEqual(['fresh.ts']);
      // No sub-batch sent during dispatch B contained 'poison.ts'.
      expect(dispatchBSubBatches.some((b) => b.includes('poison.ts'))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('drops a slot after maxRespawnsPerSlot and continues on the survivor', async () => {
    // 2-worker pool, budget=1. The worker that's assigned the chunk
    // containing `a.ts` crashes on a.ts (quarantines a), respawns, gets
    // the requeued remainder containing `b.ts`, crashes on b.ts
    // (quarantines b). That slot's respawn budget is now exhausted, so
    // the pool drops it. The OTHER slot — assigned the chunk with
    // [c,d] — never sees the poison files and completes its work
    // normally. Validates the per-slot drop + wakeIdleSlots flow under
    // real worker timing.
    //
    // The path-based crash trigger replaces an earlier shared-counter-
    // file design that was a write-write race between the two workers:
    // pre-U17 timing happened to land on counter=2 by the end of
    // round 1 (so round-2 workers saw counter==2 and didn't crash),
    // but the post-U17 protocol-decoding latency shifted the window
    // so round 2's first worker read counter=1 and crashed too,
    // producing 3 quarantines instead of 2. Switching to a path-based
    // trigger removes the inter-worker race entirely — the outcome
    // depends only on which chunk contains the poison files, which is
    // deterministic given the dispatch ordering of [a,b,c,d] with
    // subBatchSize=2.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resilience-slot-drop-'));
    const workerPath = path.join(tempDir, 'worker.js');
    writeReadyWorker(
      workerPath,
      `
      const { parentPort } = require('node:worker_threads');
      let current = [];
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((f) => f.path);
          // Crash deterministically on the poison files. The pool
          // filters quarantined paths from subsequent re-dispatches,
          // so the first crash quarantines a.ts and the requeue then
          // contains b.ts; the second crash quarantines b.ts and the
          // slot's respawn budget is exhausted. Worker handling the
          // [c,d] chunk never enters this branch.
          const poison = current.find((p) => p === 'a.ts' || p === 'b.ts');
          if (poison) {
            parentPort.postMessage({ type: 'starting-file', path: poison });
            process.exit(134);
          }
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

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 2, {
      subBatchSize: 2,
      subBatchIdleTimeoutMs: 2000,
      consecutiveFailureThreshold: 10,
      maxRespawnsPerSlot: 1,
    });

    try {
      const results = await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
        { path: 'a.ts', content: '' },
        { path: 'b.ts', content: '' },
        { path: 'c.ts', content: '' },
        { path: 'd.ts', content: '' },
      ]);

      // Deterministically: a.ts crashes round 1, b.ts crashes round 2.
      const quarantine = (pool.getQuarantinedPaths?.() ?? []).sort();
      expect(quarantine).toEqual(['a.ts', 'b.ts']);
      // All non-quarantined files eventually parsed by the survivor slot.
      const allPaths = results.flatMap((r) => r.paths).sort();
      expect(allPaths).toEqual(['c.ts', 'd.ts']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('trips the circuit breaker on cascading per-slot consecutive failures', async () => {
    // Single-slot pool with consecutiveFailureThreshold=2. Worker dies
    // on every job; after 2 consecutive deaths on slot 0 the breaker
    // trips and dispatch rejects with WorkerPoolDispatchError.
    const { tempDir, workerPath } = writeTempWorker(
      'gitnexus-resilience-breaker-',
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          const path = msg.files[0]?.path;
          if (path) parentPort.postMessage({ type: 'starting-file', path });
          process.exit(134);
        }
      });
    `,
    );

    pool = createWorkerPool(pathToFileURL(workerPath) as URL, 1, {
      subBatchIdleTimeoutMs: 2000,
      consecutiveFailureThreshold: 2,
      maxRespawnsPerSlot: 5,
    });

    try {
      const err = await pool
        .dispatch<{ path: string; content: string }, unknown>([
          { path: 'one.ts', content: '' },
          { path: 'two.ts', content: '' },
        ])
        .catch((e) => e);
      expect(err).toBeInstanceOf(WorkerPoolDispatchError);
      const dispatchErr = err as WorkerPoolDispatchError;
      // Breaker tripped with the cumulative quarantine surfaced for
      // sequential fallback. With threshold=2 + single-slot pool +
      // both items crashing in sequence, both files are in-flight
      // when their respective deaths fire, so both end up in
      // quarantine before the breaker trips. Pinning the exact set is
      // stronger than `length > 0` and surfaces a regression where
      // only one path makes it through.
      expect([...dispatchErr.quarantinedPaths].sort()).toEqual(['one.ts', 'two.ts']);
      expect(/circuit breaker tripped/i.test(dispatchErr.message)).toBe(true);

      // Subsequent dispatch rejects up front with the same error class.
      await expect(
        pool.dispatch<{ path: string; content: string }, unknown>([
          { path: 'after.ts', content: '' },
        ]),
      ).rejects.toBeInstanceOf(WorkerPoolDispatchError);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('survives a worker `error` event (uncaught throw) the same as a process.exit', async () => {
    // Worker throws an uncaught error on first sub-batch (triggers Node
    // Worker 'error' event), then the replacement succeeds. Validates
    // recoverAndResume on the errorHandler path with real async timing.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-resilience-error-event-'));
    const markerPath = path.join(tempDir, 'thrown-once.txt');
    const workerPath = path.join(tempDir, 'worker.js');
    writeReadyWorker(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const markerPath = ${JSON.stringify(markerPath)};
      let current = [];
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          current = msg.files.map((f) => f.path);
          if (!fs.existsSync(markerPath)) {
            fs.writeFileSync(markerPath, 'throw once');
            parentPort.postMessage({ type: 'starting-file', path: current[0] });
            // Uncaught throw — Node Worker emits an 'error' event.
            throw new Error('simulated native error');
          }
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
      subBatchIdleTimeoutMs: 2000,
      consecutiveFailureThreshold: 5,
      maxRespawnsPerSlot: 3,
    });

    try {
      const results = await pool.dispatch<{ path: string; content: string }, { paths: string[] }>([
        { path: 'thrown.ts', content: '' },
        { path: 'recovered.ts', content: '' },
      ]);
      expect(results.length).toBe(1);
      expect(results[0].paths).toEqual(['recovered.ts']);
      expect(pool.getQuarantinedPaths?.() ?? []).toEqual(['thrown.ts']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
