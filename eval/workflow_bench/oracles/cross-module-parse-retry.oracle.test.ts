import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';

import { dispatchChunkParseRound } from '../gitnexus/src/core/ingestion/parsing-processor.js';
import { createWorkerPool } from '../gitnexus/src/core/ingestion/workers/worker-pool.js';

// Static promise-timer imports otherwise keep real time while the oracle's
// clock advances. Both standard backoff APIs must use the same test clock.
vi.mock('node:timers/promises', async (importOriginal) => {
  const timers = await importOriginal<Record<string, unknown>>();
  const delay = (milliseconds: number, value?: unknown) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds, value));
  return { ...timers, setTimeout: delay, default: { ...timers, setTimeout: delay } };
});

const files = [{ path: 'src/retry.ts', content: 'export const retry = true;\n' }];
const recovered = {
  nodes: [],
  relationships: [],
  parsedFiles: [
    {
      filePath: files[0].path,
      moduleScope: `module:${files[0].path}`,
      scopes: [],
      parsedImports: [],
      localDefs: [],
      referenceSites: [],
    },
  ],
  skippedLanguages: {},
};
const transports = ['message', 'event', 'exit'] as const;
type Transport = (typeof transports)[number];

async function exercise(transport: Transport, failures: number, deterministic = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'wfbench-worker-'));
  const workerFile = path.join(directory, 'worker.js');
  writeFileSync(workerFile, '// injected worker transport\n');
  const failure = deterministic
    ? new SyntaxError('invalid file syntax')
    : Object.assign(new Error('EAGAIN: temporary worker resource failure'), { code: 'EAGAIN' });
  const attempts: Array<{ path: string | undefined; at: number }> = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  // Exercise actual in-flight recovery/quarantine, not a synchronous caller
  // rejection. Retry policy may live in the pool or in its pipeline caller.
  class OracleWorker extends EventEmitter {
    private dead = false;
    constructor() {
      super();
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }

    postMessage(message: { type: string; files?: Array<{ path: string }> }) {
      if (message.type === 'sub-batch') {
        const filePath = message.files?.[0]?.path;
        attempts.push({ path: filePath, at: Date.now() });
        queueMicrotask(() => {
          if (this.dead) return;
          this.emit('message', { type: 'starting-file', path: filePath });
          if (attempts.length <= failures) {
            if (transport === 'message') {
              this.emit('message', {
                type: 'error',
                error: `${failure.name}: ${failure.message}`,
                errorStack: failure.stack,
              });
            } else if (transport === 'event') {
              this.dead = true;
              this.emit('error', failure);
              this.emit('exit', 1);
            } else {
              this.dead = true;
              this.emit('exit', deterministic ? 65 : 75);
            }
            return;
          }
          this.emit('message', { type: 'progress', filesProcessed: files.length });
          this.emit('message', { type: 'sub-batch-done' });
        });
      } else if (message.type === 'flush') {
        queueMicrotask(() => this.emit('message', { type: 'result', data: recovered }));
      }
    }

    async terminate() {
      if (!this.dead) {
        this.dead = true;
        this.emit('exit', 0);
      }
      return 0;
    }
    unref() {
      return this;
    }
  }

  const pool = createWorkerPool(pathToFileURL(workerFile), 1, {
    workerFactory: () => new OracleWorker() as unknown as Worker,
    stallMsProbe: () => 0,
    subBatchIdleTimeoutMs: 120_000,
  });
  try {
    let outcome:
      | { results?: Awaited<ReturnType<typeof dispatchChunkParseRound>>; error?: unknown }
      | undefined;
    // Ingestion uses the round API; the single-chunk API delegates to it.
    void dispatchChunkParseRound([{ items: files }], pool).then(
      (results) => {
        outcome = { results };
      },
      (error) => {
        outcome = { error };
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome, 'bounded retries must settle').toBeDefined();
    return {
      ...outcome,
      attempts,
      parsedPaths:
        outcome?.results
          ?.flat()
          .flatMap((result) => result.parsedFiles?.map((file) => file.filePath) ?? []) ?? [],
      quarantined: pool.getQuarantinedPaths?.() ?? [],
    };
  } finally {
    await pool.terminate();
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('hidden oracle: bounded in-flight parse-worker retry', () => {
  it.each(transports)(
    'recovers the same file after two transient %s failures with backoff',
    async (transport) => {
      const outcome = await exercise(transport, 2);
      expect(outcome.error).toBeUndefined();
      expect(outcome.results).toEqual([[recovered]]);
      expect(outcome.attempts).toHaveLength(3);
      expect(outcome.attempts.map((attempt) => attempt.path)).toEqual(Array(3).fill(files[0].path));
      expect(outcome.attempts[1].at).toBeGreaterThan(outcome.attempts[0].at);
      expect(outcome.attempts[2].at).toBeGreaterThan(outcome.attempts[1].at);
      expect(outcome.quarantined).not.toContain(files[0].path);
    },
  );

  it.each(transports)(
    'stops after two retries of a transient %s failure and reports the file',
    async (transport) => {
      const outcome = await exercise(transport, Infinity);
      expect(outcome.attempts).toHaveLength(3);
      expect(outcome.attempts[1].at).toBeGreaterThan(outcome.attempts[0].at);
      expect(outcome.attempts[2].at).toBeGreaterThan(outcome.attempts[1].at);
      expect(outcome.parsedPaths).not.toContain(files[0].path);
      expect(outcome.error !== undefined || outcome.quarantined.includes(files[0].path)).toBe(true);
    },
  );

  it.each(transports)('does not retry a deterministic %s parse failure', async (transport) => {
    const outcome = await exercise(transport, Infinity, true);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.parsedPaths).not.toContain(files[0].path);
    expect(outcome.error !== undefined || outcome.quarantined.includes(files[0].path)).toBe(true);
  });
});
