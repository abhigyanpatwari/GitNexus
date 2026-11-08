import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  AutoSyncAnalysisError,
  createAutoSyncAnalysisRunner as createRunner,
  type AutoSyncAnalysisRunner,
} from '../../src/core/auto-sync/analysis-worker-launch.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';
import * as hostResources from '../../src/core/analysis-host-resources.js';

function createAutoSyncAnalysisRunner(overrides: Parameters<typeof createRunner>[0]) {
  const run = createRunner(overrides);
  return (...args: Parameters<AutoSyncAnalysisRunner>) => {
    const slots = args[5] ?? 1;
    args[1] = {
      ...args[1],
      resources: resolveAnalysisResourceBudget({
        effectiveMemoryBytes: (16 * 1024 ** 3) / slots,
        availableCpus: Math.max(1, 8 / slots),
        mainHeapMb: 2048 / slots,
        modelMemoryMb: 0,
      }),
    };
    return run(...args);
  };
}

const handoff = {
  version: 1 as const,
  publicationId: 'a'.repeat(32),
  repoPath: '/tmp/repo',
  storagePath: '/tmp/repo/.gitnexus',
  metadataDirectory: '/tmp/repo/.gitnexus',
  repoName: 'repo',
  commit: 'b'.repeat(40),
};

function createChild() {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    send: vi.fn(),
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
  });
}

describe('auto-sync analysis worker', () => {
  it.each(['timeout', 'abort'] as const)(
    'covers resource preflight with %s without launching a late worker',
    async (reason) => {
      let finish!: (value: boolean) => void;
      const preflight = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      const mayEmbed = vi.spyOn(hostResources, 'analysisMayEmbed').mockReturnValue(preflight);
      const forkWorker = vi.fn();
      let expire!: () => void;
      const setTimeoutFn = vi.fn((callback: () => void) => {
        expire = callback;
        return 1;
      });
      const clearTimeoutFn = vi.fn();
      const onCancellationRequested = vi.fn();
      const controller = new AbortController();
      const run = createRunner({
        forkWorker,
        setTimeoutFn: setTimeoutFn as any,
        clearTimeoutFn: clearTimeoutFn as any,
      });
      try {
        const pending = run('/tmp/repo', {}, 50, controller.signal, onCancellationRequested);
        expect(mayEmbed).toHaveBeenCalledOnce();
        expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 50);
        if (reason === 'timeout') expire();
        else controller.abort();
        await expect(pending).rejects.toThrow(reason === 'timeout' ? 'timed out' : 'cancelled');
        expect(onCancellationRequested).toHaveBeenCalledOnce();
        expect(clearTimeoutFn).toHaveBeenCalledWith(1);
        finish(false);
        await preflight;
        expect(forkWorker).not.toHaveBeenCalled();
        expect(setTimeoutFn).toHaveBeenCalledOnce();
      } finally {
        finish(false);
        mayEmbed.mockRestore();
      }
    },
  );

  it.each([1, 4])('launches the admitted heap for %s concurrent repositories', async (slots) => {
    const mayEmbed = vi.spyOn(hostResources, 'analysisMayEmbed').mockResolvedValue(false);
    const admission = vi
      .spyOn(hostResources, 'resolveHostAnalysisResources')
      .mockImplementation((options) =>
        resolveAnalysisResourceBudget({
          effectiveMemoryBytes: (32 * 1024 ** 3) / slots,
          availableCpus: 8,
          mainHeapMb: options.mainHeapMb,
          modelMemoryMb: 0,
        }),
      );
    const child = createChild();
    const forkWorker = vi.fn(() => child as any);
    const run = createRunner({ forkWorker });
    try {
      const pending = run('/tmp/repo', {}, 30_000, undefined, undefined, slots);
      await vi.waitFor(() => expect(forkWorker).toHaveBeenCalledOnce());
      expect(admission).toHaveBeenCalledWith(expect.objectContaining({ concurrency: slots }));
      const admitted = admission.mock.results[0].value;
      expect(admission.mock.calls[0][0].mainHeapMb).toBeUndefined();
      expect(admitted.parse.reservedBytes * slots).toBeLessThanOrEqual(24 * 1024 ** 3);
      expect(forkWorker).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          `--max-old-space-size=${admitted.mainHeapMb - 48}`,
          '--max-semi-space-size=16',
        ]),
      );
      child.emit('message', { type: 'complete', result: { stats: { files: 1 } } });
      child.emit('exit', 0, null);
      await expect(pending).resolves.toEqual({ stats: { files: 1 } });
    } finally {
      mayEmbed.mockRestore();
      admission.mockRestore();
    }
  });
  it('continues after actual exit and retains the original timeout across phases', async () => {
    const graph = createChild();
    const embedding = createChild();
    const forkWorker = vi.fn().mockReturnValueOnce(graph).mockReturnValueOnce(embedding);
    const clearTimeoutFn = vi.fn();
    const run = createAutoSyncAnalysisRunner({
      forkWorker,
      setTimeoutFn: vi.fn(() => 1) as any,
      clearTimeoutFn: clearTimeoutFn as any,
    });
    const pending = run('/tmp/repo', {}, 50);
    const prepared = { type: 'graph-prepared', handoff, result: { stats: { files: 3 } } };
    graph.emit('message', prepared);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(clearTimeoutFn).not.toHaveBeenCalled();
    graph.emit('exit', 0, null);
    expect(forkWorker).toHaveBeenCalledTimes(2);
    expect(clearTimeoutFn).not.toHaveBeenCalled();
    expect(embedding.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'continue',
        prepared,
        writerPid: graph.pid,
      }),
    );
    embedding.emit('message', { type: 'graph-ready' });
    expect(embedding.send).toHaveBeenLastCalledWith({ type: 'graph-visible' });
    let done = false;
    void pending.then(() => {
      done = true;
    });
    embedding.emit('message', { type: 'complete', result: { stats: { files: 3 } } });
    await Promise.resolve();
    expect(done).toBe(false);
    embedding.emit('exit', 0, null);
    await expect(pending).resolves.toEqual({ stats: { files: 3 } });
  });

  it('never starts a continuation after an unsuccessful graph exit', async () => {
    const child = createChild();
    const forkWorker = vi.fn(() => child as any);
    const run = createAutoSyncAnalysisRunner({ forkWorker });
    const pending = run('/tmp/repo', {}, 50);
    child.emit('message', { type: 'graph-prepared', handoff, result: { stats: {} } });
    child.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('exited before completion');
    expect(forkWorker).toHaveBeenCalledTimes(1);
  });

  it('does not treat graph-prepared as terminal or clear the active timeout', async () => {
    const child = createChild();
    const clearTimeoutFn = vi.fn();
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
      setTimeoutFn: vi.fn(() => 1) as any,
      clearTimeoutFn: clearTimeoutFn as any,
    });
    const result = run('/tmp/repo', {}, 50);
    child.emit('message', { type: 'graph-prepared', handoff, result: { stats: { files: 3 } } });
    expect(clearTimeoutFn).not.toHaveBeenCalled();
    child.emit('message', { type: 'error', message: 'cancelled after preparing' });
    child.emit('exit', 0, null);
    await expect(result).rejects.toThrow('cancelled after preparing');
  });

  it('ignores progress and resolves from the terminal complete message', async () => {
    const child = createChild();
    const forkWorker = vi.fn(() => child as any);
    const run = createAutoSyncAnalysisRunner({ forkWorker });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    expect(forkWorker).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--max-old-space-size=2000']),
    );
    child.emit('message', { type: 'progress', phase: 'parsing', percent: 20, message: 'Parsing' });
    child.emit('message', { type: 'complete', result: { stats: { files: 3 } } });
    child.emit('exit', 0, null);

    await expect(result).resolves.toEqual({ stats: { files: 3 } });
    expect(child.stdout.resume).toHaveBeenCalled();
    expect(child.stderr.resume).toHaveBeenCalled();
  });

  it('passes a collapsed graph write through with the stats', async () => {
    const child = createChild();
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });
    const result = run('/tmp/repo', {}, 50);
    const graphWriteCollapsed = { expected: 930, persisted: 12 };
    child.emit('message', {
      type: 'complete',
      result: { stats: { files: 3 }, graphWriteCollapsed },
    });
    child.emit('exit', 0, null);
    await expect(result).resolves.toEqual({ stats: { files: 3 }, graphWriteCollapsed });
  });

  it('reports progress until the terminal message, skipping worker log lines; a throwing listener changes nothing', async () => {
    const child = createChild();
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });
    const onProgress = vi.fn().mockImplementationOnce(() => {
      throw new Error('listener failed');
    });

    const result = run('/tmp/repo', {}, 50, undefined, undefined, undefined, onProgress);
    child.emit('message', { type: 'progress', phase: 'parsing', percent: 20, message: 'Parsing' });
    // A worker log line, not progress.
    child.emit('message', { type: 'progress', phase: 'log', percent: -1, message: 'warn: x' });
    child.emit('message', { type: 'progress', phase: 'graph', percent: 60, message: 'Graph' });
    child.emit('message', { type: 'complete', result: { stats: { files: 3 } } });
    child.emit('message', { type: 'progress', phase: 'late', percent: 99, message: 'Late' });
    child.emit('exit', 0, null);

    await expect(result).resolves.toEqual({ stats: { files: 3 } });
    expect(onProgress.mock.calls).toEqual([
      [20, 'Parsing'],
      [60, 'Graph'],
    ]);
  });

  it('rejects on a worker error even when no exit event follows', async () => {
    const child = createChild();
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });
    const result = run('/tmp/repo', { branch: 'main' }, 50);

    child.emit('error', new Error('IPC disconnected'));

    expect(child.send).toHaveBeenLastCalledWith({ type: 'cancel' });
    await expect(result).rejects.toThrow('Auto-sync analyze worker error: IPC disconnected');
  });

  it('rejects when the initial worker message cannot be sent', async () => {
    const child = createChild();
    child.send.mockImplementationOnce(() => {
      throw new Error('IPC channel closed');
    });
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });

    const result = run('/tmp/repo', { branch: 'main' }, 50);

    await expect(result).rejects.toThrow(
      'Failed to start auto-sync analyze worker: IPC channel closed',
    );
    expect(child.send).toHaveBeenNthCalledWith(2, { type: 'cancel' });
  });

  it('preserves a worker terminal error', async () => {
    const child = createChild();
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    child.emit('message', { type: 'progress', phase: 'parsing', percent: 20, message: 'Parsing' });
    child.emit('message', { type: 'error', message: 'parser crashed' });
    child.emit('exit', 1, null);

    await expect(result).rejects.toThrow('parser crashed');
  });

  it('preserves worker index-lock-timeout code and retryable on the parent error', async () => {
    const child = createChild();
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    child.emit('message', {
      type: 'error',
      message: 'waited for the index lock',
      code: 'index-lock-timeout',
      retryable: true,
    });
    child.emit('exit', 1, null);

    await expect(result).rejects.toMatchObject({
      name: 'AutoSyncAnalysisError',
      message: 'waited for the index lock',
      code: 'index-lock-timeout',
      retryable: true,
      abandonedWorker: false,
    });
    await expect(result).rejects.toBeInstanceOf(AutoSyncAnalysisError);
  });

  it('requests cancellation after timeout, reports it, and waits for exit', async () => {
    const child = createChild();
    const timers: Array<() => void> = [];
    const onCancellationRequested = vi.fn();
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
      setTimeoutFn: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const result = run('/tmp/repo', { branch: 'main' }, 50, undefined, onCancellationRequested);
    timers[0]!();

    expect(onCancellationRequested).toHaveBeenCalledOnce();
    expect(child.send).toHaveBeenLastCalledWith({ type: 'cancel' });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('exit', 0, null);
    await expect(result).rejects.toThrow('Analysis timed out after 50ms');
  });

  it('keeps the timeout outcome when complete arrives after cancellation begins', async () => {
    const child = createChild();
    const timers: Array<() => void> = [];
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
      setTimeoutFn: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    timers[0]!();
    child.emit('message', { type: 'complete', result: { stats: { files: 3 } } });
    child.emit('exit', 0, null);

    await expect(result).rejects.toThrow('Analysis timed out after 50ms');
  });

  it('does not send cancellation after a terminal complete message', async () => {
    const child = createChild();
    const timers: Array<() => void> = [];
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
      setTimeoutFn: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    child.emit('message', { type: 'complete', result: { stats: { files: 3 } } });
    child.emit('exit', 0, null);

    await expect(result).resolves.toEqual({ stats: { files: 3 } });
    expect(child.send).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
  });

  it.each(['complete', 'error'] as const)(
    'preserves a terminal %s received before the deadline while waiting for exit',
    async (type) => {
      vi.useFakeTimers();
      try {
        const child = createChild();
        const run = createAutoSyncAnalysisRunner({
          forkWorker: vi.fn(() => child as any),
          setTimeoutFn: setTimeout,
          clearTimeoutFn: clearTimeout,
        });
        const result = run('/tmp/repo', {}, 50).catch((error: unknown) => error);
        let settled = false;
        void result.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(49);
        child.emit(
          'message',
          type === 'complete'
            ? { type, result: { stats: { files: 3 } } }
            : { type, message: 'worker failed' },
        );
        await vi.advanceTimersByTimeAsync(500);
        expect(settled).toBe(false);
        expect(child.send).toHaveBeenCalledTimes(1);
        child.emit('exit', 0, null);
        if (type === 'complete') await expect(result).resolves.toEqual({ stats: { files: 3 } });
        else await expect(result).resolves.toMatchObject({ message: 'worker failed' });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('divides the worker heap by the number of repos analyzed in parallel', async () => {
    // Stubbed timers so neither run leaves a live timeout behind for the rest
    // of the suite, and both promises are settled before the test returns.
    const timers: Array<() => void> = [];
    const forkChildren: ReturnType<typeof createChild>[] = [];
    const forkWorker = vi.fn(() => {
      const child = createChild();
      forkChildren.push(child);
      return child as any;
    });
    const run = createAutoSyncAnalysisRunner({
      forkWorker,
      setTimeoutFn: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const parallel = run('/tmp/repo', { branch: 'main' }, 50, undefined, undefined, 4);
    expect(forkWorker).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.arrayContaining(['--max-old-space-size=464']),
    );

    const solo = run('/tmp/repo', { branch: 'main' }, 50);
    expect(forkWorker).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.arrayContaining(['--max-old-space-size=2000']),
    );

    for (const child of forkChildren) {
      child.emit('message', { type: 'complete', result: { stats: { files: 1 } } });
      child.emit('exit', 0, null);
    }
    await expect(parallel).resolves.toEqual({ stats: { files: 1 } });
    await expect(solo).resolves.toEqual({ stats: { files: 1 } });
  });

  it.each([0, 1])('tracks an abandoned worker until exit (%s)', async (exitCode) => {
    const child = Object.assign(createChild(), {
      unref: vi.fn(),
      channel: { unref: vi.fn() },
    });
    const timers: Array<() => void> = [];
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
      setTimeoutFn: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length as any;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    timers[0]!();
    expect(child.send).toHaveBeenLastCalledWith({ type: 'cancel' });

    // No 'exit' arrives during the grace period.
    timers[1]!();

    await expect(result).rejects.toThrow('did not exit within');
    await expect(result).rejects.toMatchObject({
      name: 'AutoSyncAnalysisError',
      abandonedWorker: true,
      retryable: true,
    });
    // The parent stops waiting; the child is released, never killed.
    expect(child.channel.unref).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledTimes(2);

    const failure = (await result.catch((error) => error)) as AutoSyncAnalysisError;
    expect(failure.workerExited).toBeInstanceOf(Promise);
    const exited = vi.fn();
    void failure.workerExited?.then(exited);
    // A late completion message is not proof that the process has exited.
    child.emit('message', { type: 'complete', result: { stats: { files: 1 } } });
    await Promise.resolve();
    expect(exited).not.toHaveBeenCalled();
    child.emit('exit', exitCode, null);
    await failure.workerExited;
    expect(exited).toHaveBeenCalledOnce();
  });

  it('uses the same cancellation request for an aborted watch run', async () => {
    const child = createChild();
    const controller = new AbortController();
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });

    const result = run('/tmp/repo', { branch: 'main' }, 50, controller.signal);
    controller.abort();
    expect(child.send).toHaveBeenLastCalledWith({ type: 'cancel' });

    child.emit('exit', 0, null);
    await expect(result).rejects.toThrow('Analysis cancelled');
  });
});
