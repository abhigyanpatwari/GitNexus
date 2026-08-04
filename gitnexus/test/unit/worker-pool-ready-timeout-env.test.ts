/**
 * `GITNEXUS_WORKER_READY_TIMEOUT_MS` overrides the worker ready budget.
 *
 * The 5s default is a startup budget for parser + grammar imports. On a slow
 * or heavily loaded host a full pool of workers cold-starting concurrently
 * can legitimately need more: without an override every slot misses the
 * handshake, the identical timeout messages reproduce across respawns, and
 * the pool misclassifies the slow start as a deterministic startup
 * crash-loop — aborting the whole analyze. The env var mirrors
 * `GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS`.
 *
 * `resolveWorkerPoolOptions` reads the env var fresh on every
 * `createWorkerPool` call, so each test just sets the env var before
 * constructing the pool — no module reset needed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createWorkerPool,
  WorkerPoolInitializationError,
} from '../../src/core/ingestion/workers/worker-pool.js';

/** Worker double that never reports ready and never exits: a slow starter. */
class NeverReadyWorker extends EventEmitter {
  readonly stderr = new EventEmitter();
  postMessage(): void {}
  async terminate(): Promise<number> {
    return 0;
  }
}

let tempDir: string;
let workerUrl: URL;
const ENV_KEY = 'GITNEXUS_WORKER_READY_TIMEOUT_MS';
let savedEnv: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worker-ready-timeout-'));
  const workerPath = path.join(tempDir, 'fake-worker.js');
  fs.writeFileSync(workerPath, '// fake');
  workerUrl = pathToFileURL(workerPath) as URL;
  savedEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('worker pool — GITNEXUS_WORKER_READY_TIMEOUT_MS override', () => {
  it('applies the override to the readiness deadline and its failure message', async () => {
    process.env[ENV_KEY] = '50';
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new NeverReadyWorker() as unknown as Worker,
    });

    const err = await pool
      .dispatch([{ path: 'a.ts', content: 'x' }])
      .catch((e: unknown) => e as InstanceType<typeof WorkerPoolInitializationError>);

    expect(err).toBeInstanceOf(WorkerPoolInitializationError);
    expect(err.readinessFailures.join('\n')).toContain('within 50ms');

    await pool.terminate().catch(() => undefined);
  });

  it('falls back to the 5s default when the value is not a positive integer', async () => {
    process.env[ENV_KEY] = 'not-a-number';
    const pool = createWorkerPool(workerUrl, 1, {
      workerFactory: () => new NeverReadyWorker() as unknown as Worker,
    });

    const err = await pool
      .dispatch([{ path: 'a.ts', content: 'x' }])
      .catch((e: unknown) => e as InstanceType<typeof WorkerPoolInitializationError>);

    expect(err).toBeInstanceOf(WorkerPoolInitializationError);
    expect(err.readinessFailures.join('\n')).toContain('within 5000ms');

    await pool.terminate().catch(() => undefined);
  });
});
