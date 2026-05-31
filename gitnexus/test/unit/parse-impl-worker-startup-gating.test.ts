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
import { describe, expect, it, vi } from 'vitest';
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
      handleWorkerStartupFailure(initError(STDERR_FAILURE), { workerPoolSize: 8 }, vi.fn(), 0, true);
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
      handleWorkerStartupFailure(initError(STDERR_FAILURE), { workerPoolSize: 0 }, onProgress, 30, true),
    ).not.toThrow();
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
