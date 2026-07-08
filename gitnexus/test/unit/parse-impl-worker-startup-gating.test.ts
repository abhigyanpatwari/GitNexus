/**
 * Worker-startup failure handling (#1741).
 *
 * The worker pool self-heals *transient* startup crashes on its own — a
 * bounded, jittered restart loop (see worker-pool.ts). `handleWorkerStartupFailure`
 * is reached only when that self-heal is EXHAUSTED, a deterministic crash-loop
 * was detected, or the pool could not be constructed — i.e. the workers truly
 * cannot start. In every such case it FAILS FAST with the captured cause.
 * There is no sequential parser to silently degrade to — that fallback was
 * removed (it had masked a worker-startup regression as a 123-minute "stuck"
 * run in #1741). The message names the fix (the worker startup / construction
 * error) rather than offering a `--workers 0` escape hatch, which no longer
 * exists.
 */
import { describe, expect, it } from 'vitest';
import { handleWorkerStartupFailure } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import {
  WorkerPoolInitializationError,
  type StartupCrashClass,
} from '../../src/core/ingestion/workers/worker-pool.js';

const STDERR_TAIL = 'Worker stderr:\nError: Cannot find module tree-sitter-c-sharp';

const initError = (crashClass: StartupCrashClass) =>
  new WorkerPoolInitializationError(
    'Worker pool has no active workers after initial ready handshake',
    [],
    [
      `Replacement worker did not report ready within 5000ms — likely crashed ` +
        `during top-of-script init. ${STDERR_TAIL}`,
    ],
    crashClass,
  );

const messageFrom = (fn: () => void): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected handleWorkerStartupFailure to throw');
};

describe('handleWorkerStartupFailure — always fail fast with the cause (#1741)', () => {
  it('throws on a deterministic startup crash-loop and names it', () => {
    const message = messageFrom(() =>
      handleWorkerStartupFailure(initError('deterministic-startup')),
    );
    expect(message).toMatch(/deterministic/i);
    expect(message).toContain('tree-sitter-c-sharp'); // captured stderr propagated
    // Sequential parsing was removed: the message no longer offers a `--workers 0`
    // escape hatch — it names the fix instead (fail clearly, no silent fallback).
    expect(message).not.toContain('--workers 0');
    expect(message).toContain('Fix the worker startup failure');
    // The native-binding hint is apt for an init crash and is kept (R7).
    expect(message).toMatch(/native binding/i);
  });

  it('throws when the bounded startup retry budget was exhausted', () => {
    const message = messageFrom(() => handleWorkerStartupFailure(initError('transient-exhausted')));
    expect(message).toMatch(/exhausted the bounded startup retry budget/i);
    expect(message).toContain('tree-sitter-c-sharp');
    expect(message).not.toContain('--workers 0');
    expect(message).toContain('Fix the worker startup failure');
  });

  it('throws on a pool *construction* failure (plain Error, not an init error)', () => {
    const message = messageFrom(() =>
      handleWorkerStartupFailure(new Error('Worker script not found: /tmp/parse-worker.js')),
    );
    expect(message).toMatch(/could not be constructed/i);
    expect(message).not.toContain('--workers 0');
    expect(message).toContain('Fix the worker pool construction error');
    // The real construction error is surfaced verbatim (R7) …
    expect(message).toContain('Worker script not found: /tmp/parse-worker.js');
    // … and the native-binding guess is NOT applied to a construction failure.
    expect(message).not.toMatch(/native binding/i);
  });

  it('never silently degrades — there is no non-throwing path', () => {
    // Both an init error and a plain error must throw; the function returns
    // `never`. A regression that let it fall through would resurrect #1741.
    expect(() => handleWorkerStartupFailure(initError('transient-exhausted'))).toThrow();
    expect(() => handleWorkerStartupFailure(new Error('boom'))).toThrow();
  });
});
