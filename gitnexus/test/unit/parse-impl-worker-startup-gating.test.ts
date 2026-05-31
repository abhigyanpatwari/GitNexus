/**
 * Worker-startup failure gating (#1741).
 *
 * When the parse phase's worker pool fails to start (every worker crashes
 * during top-of-script init, so the pool reports zero usable workers),
 * `handleWorkerStartupFailure` decides between two outcomes:
 *
 *   - fail-fast: throw an actionable error when the operator explicitly
 *     sized the pool (`--workers <N>`) and did not opt into fallback. This
 *     replaces the old silent degrade-to-sequential that turned a worker
 *     startup bug into a 123-minute "stuck" parse in #1741 (rc99).
 *   - loud degrade: log + surface a progress warning, then let the caller
 *     parse sequentially. Used for auto-sized pools and when fallback is
 *     explicitly allowed.
 *
 * Either way the underlying worker crash detail (carried on
 * `WorkerPoolInitializationError.readinessFailures`, now including captured
 * worker stderr) is surfaced, never swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineProgress } from 'gitnexus-shared';
import { handleWorkerStartupFailure } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { WorkerPoolInitializationError } from '../../src/core/ingestion/workers/worker-pool.js';

const initError = (failures: string[]) =>
  new WorkerPoolInitializationError(
    'Worker pool has no active workers after initial ready handshake',
    [],
    failures,
  );

const STDERR_FAILURE = [
  'Replacement worker did not report ready within 5000ms — likely crashed during ' +
    'top-of-script init. Worker stderr:\nError: Cannot find module tree-sitter-c-sharp',
];

describe('handleWorkerStartupFailure — fail-fast vs loud degrade (#1741)', () => {
  // The gate also reads GITNEXUS_WORKER_POOL_SIZE directly (env-channel explicit
  // sizing), so keep the suite hermetic: an ambient env var would otherwise turn
  // the "auto-sized" cases below into unexpected fail-fast throws.
  const savedEnv = process.env.GITNEXUS_WORKER_POOL_SIZE;
  beforeEach(() => {
    delete process.env.GITNEXUS_WORKER_POOL_SIZE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GITNEXUS_WORKER_POOL_SIZE;
    else process.env.GITNEXUS_WORKER_POOL_SIZE = savedEnv;
  });

  it('throws an actionable error when --workers was explicit and fallback not allowed', () => {
    const onProgress = vi.fn();
    expect(() =>
      handleWorkerStartupFailure(
        initError(STDERR_FAILURE),
        { workerPoolSize: 8 },
        onProgress,
        42,
        true,
      ),
    ).toThrow(/every worker crashed during top-of-script init/i);
    // No progress warning on the fatal path — the throw is the signal.
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('the thrown error surfaces the real worker crash and the escape hatches', () => {
    let message = '';
    try {
      handleWorkerStartupFailure(
        initError(STDERR_FAILURE),
        { workerPoolSize: 8 },
        vi.fn(),
        0,
        true,
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('tree-sitter-c-sharp'); // captured stderr propagated
    expect(message).toContain('--workers 8');
    expect(message).toContain('--allow-sequential-fallback');
    expect(message).toContain('--workers 0');
  });

  it('degrades loudly (no throw) when --allow-sequential-fallback is set', () => {
    const onProgress = vi.fn();
    expect(() =>
      handleWorkerStartupFailure(
        initError(STDERR_FAILURE),
        { workerPoolSize: 8, allowSequentialFallback: true },
        onProgress,
        55,
        true,
      ),
    ).not.toThrow();
    const progress = onProgress.mock.calls[0][0] as PipelineProgress;
    expect(progress.phase).toBe('parsing');
    expect(progress.percent).toBe(55);
    expect(progress.message).toMatch(/SEQUENTIALLY/);
    expect(progress.detail).toContain('tree-sitter-c-sharp');
  });

  it('degrades loudly (no throw) for an auto-sized pool (no explicit --workers)', () => {
    const onProgress = vi.fn();
    expect(() =>
      handleWorkerStartupFailure(initError(STDERR_FAILURE), {}, onProgress, 30, true),
    ).not.toThrow();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('treats --workers 0 (workers disabled) as a non-fatal degrade', () => {
    const onProgress = vi.fn();
    expect(() =>
      handleWorkerStartupFailure(
        initError(STDERR_FAILURE),
        { workerPoolSize: 0 },
        onProgress,
        30,
        true,
      ),
    ).not.toThrow();
  });

  // ── Env-channel explicit sizing (#1741) ──────────────────────────────────
  // A pool sized via GITNEXUS_WORKER_POOL_SIZE (no --workers flag) is just as
  // operator-explicit as --workers, so it must arm the same fail-fast gate.
  it('fails fast when the pool was sized via GITNEXUS_WORKER_POOL_SIZE (no --workers)', () => {
    process.env.GITNEXUS_WORKER_POOL_SIZE = '16';
    const onProgress = vi.fn();
    let message = '';
    try {
      // options.workerPoolSize is undefined — the env var is the only signal.
      handleWorkerStartupFailure(initError(STDERR_FAILURE), {}, onProgress, 30, true);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('every worker crashed during top-of-script init');
    // The remedy names the channel the operator actually used.
    expect(message).toContain('GITNEXUS_WORKER_POOL_SIZE=16');
    expect(message).toContain('tree-sitter-c-sharp'); // real crash still surfaced
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('still degrades (no throw) for an env-sized pool when fallback is allowed', () => {
    process.env.GITNEXUS_WORKER_POOL_SIZE = '16';
    const onProgress = vi.fn();
    expect(() =>
      handleWorkerStartupFailure(
        initError(STDERR_FAILURE),
        { allowSequentialFallback: true },
        onProgress,
        30,
        true,
      ),
    ).not.toThrow();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('treats GITNEXUS_WORKER_POOL_SIZE=0 as non-explicit (degrades, no throw)', () => {
    process.env.GITNEXUS_WORKER_POOL_SIZE = '0';
    const onProgress = vi.fn();
    expect(() =>
      handleWorkerStartupFailure(initError(STDERR_FAILURE), {}, onProgress, 30, true),
    ).not.toThrow();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('never hard-fails on a pool *construction* failure (fatalEligible=false)', () => {
    const onProgress = vi.fn();
    expect(() =>
      handleWorkerStartupFailure(
        new Error('Worker script not found: /tmp/parse-worker.js'),
        { workerPoolSize: 8 },
        onProgress,
        30,
        false,
      ),
    ).not.toThrow();
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
