import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createAutoSyncAnalysisRunner } from '../../src/core/auto-sync/analysis-worker-launch.js';

describe('auto-sync analysis worker', () => {
  it('ignores progress and resolves from the terminal complete message', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
    });
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    child.emit('message', { type: 'progress', phase: 'parsing', progress: 20 });
    child.emit('message', { type: 'complete', result: { stats: { files: 3 } } });
    child.emit('exit', 0, null);

    await expect(result).resolves.toEqual({ stats: { files: 3 } });
    expect(child.stdout.resume).toHaveBeenCalled();
    expect(child.stderr.resume).toHaveBeenCalled();
  });

  it('rejects immediately when the worker emits an error without exiting', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
    });
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    child.emit('error', new Error('spawn failed'));

    await expect(result).rejects.toThrow('Auto-sync analyze worker error: spawn failed');
  });

  it('preserves a worker error after progress messages', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
    });
    const run = createAutoSyncAnalysisRunner({ forkWorker: vi.fn(() => child as any) });

    const result = run('/tmp/repo', { branch: 'main' }, 50);
    child.emit('message', { type: 'progress', phase: 'parsing', progress: 20 });
    child.emit('message', { type: 'error', message: 'parser crashed' });
    child.emit('exit', 1, null);

    await expect(result).rejects.toThrow('parser crashed');
  });
  it('waits for timed-out worker exit before releasing the scheduled run', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
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
    expect(child.send).toHaveBeenCalledWith({
      type: 'start',
      repoPath: '/tmp/repo',
      options: { branch: 'main' },
    });

    timers[0]();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    timers[1]();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('exit', null, 'SIGKILL');
    await expect(result).rejects.toThrow('Analysis timed out after 50ms');
  });

  it('kills an active worker immediately when watch is stopped', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
    });
    const run = createAutoSyncAnalysisRunner({
      forkWorker: vi.fn(() => child as any),
    });
    const controller = new AbortController();

    const result = run('/tmp/repo', { branch: 'main' }, 50, controller.signal);
    controller.abort();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await expect(result).rejects.toThrow('Analysis cancelled');
  });
});
