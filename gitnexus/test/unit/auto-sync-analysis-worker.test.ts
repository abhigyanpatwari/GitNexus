import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const { autoHeapCapMbMock } = vi.hoisted(() => ({ autoHeapCapMbMock: vi.fn(() => 512) }));
vi.mock('../../src/core/ingestion/utils/effective-ram.js', () => ({
  autoHeapCapMb: autoHeapCapMbMock,
}));

import { createAutoSyncAnalysisRunner } from '../../src/core/auto-sync/analysis-worker-launch.js';

function createChild() {
  return Object.assign(new EventEmitter(), {
    send: vi.fn(),
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
  });
}

describe('auto-sync analysis worker', () => {
  it('ignores progress and resolves from the terminal complete message', async () => {
    const child = createChild();
    const forkWorker = vi.fn(() => child as any);
    const run = createAutoSyncAnalysisRunner({ forkWorker });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    expect(forkWorker).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--max-old-space-size=512']),
    );
    child.emit('message', { type: 'progress', phase: 'parsing', percent: 20, message: 'Parsing' });
    child.emit('message', { type: 'complete', result: { stats: { files: 3 } } });
    child.emit('exit', 0, null);

    await expect(result).resolves.toEqual({ stats: { files: 3 } });
    expect(child.stdout.resume).toHaveBeenCalled();
    expect(child.stderr.resume).toHaveBeenCalled();
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

  it('divides the worker heap by the number of repos analyzed in parallel', () => {
    const child = createChild();
    const forkWorker = vi.fn(() => child as any);
    const run = createAutoSyncAnalysisRunner({ forkWorker });

    void run('/tmp/repo', { branch: 'main' }, 50, undefined, undefined, 4);
    expect(forkWorker).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--max-old-space-size=128']),
    );

    void run('/tmp/repo', { branch: 'main' }, 50);
    expect(forkWorker).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.arrayContaining(['--max-old-space-size=512']),
    );
  });

  it('stops waiting for a worker that never exits after cancellation', async () => {
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

    // No 'exit' ever arrives — the worker is wedged past its safe point.
    timers[1]!();

    await expect(result).rejects.toThrow('did not exit within');
    // The parent stops waiting; the child is released, never killed.
    expect(child.channel.unref).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledTimes(2);
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
