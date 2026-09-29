import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  JobManager,
  isTerminalJobStatus,
  type AnalyzeJobPartialOutcome,
} from '../../src/server/analyze-job.js';

describe('JobManager', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates a job with queued status', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    expect(job.id).toBeTruthy();
    expect(job.status).toBe('queued');
    expect(job.repoUrl).toBe('https://github.com/user/repo');
  });

  it('retrieves a job by id', () => {
    const created = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const retrieved = manager.getJob(created.id);
    expect(retrieved).toEqual(created);
  });

  it('returns undefined for unknown job id', () => {
    expect(manager.getJob('nonexistent')).toBeUndefined();
  });

  it('enforces single-slot concurrency', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo1' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    expect(() => manager.createJob({ repoUrl: 'https://github.com/user/repo2' })).toThrow(
      /already in progress/,
    );
  });

  it('allows new job after previous completes', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo1' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    manager.updateJob(job1.id, { status: 'complete' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo2' });
    expect(job2.status).toBe('queued');
  });

  it('returns existing job for same repoUrl when active', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    expect(job2.id).toBe(job1.id);
  });

  it('returns existing job for the same repoUrl AND the same branch', () => {
    const job1 = manager.createJob({
      repoUrl: 'https://github.com/user/repo',
      branch: 'development',
    });
    manager.updateJob(job1.id, { status: 'analyzing' });
    const job2 = manager.createJob({
      repoUrl: 'https://github.com/user/repo',
      branch: 'development',
    });
    expect(job2.id).toBe(job1.id);
  });

  it('does not return the active job to a caller asking for a different branch', () => {
    const job1 = manager.createJob({
      repoUrl: 'https://github.com/user/repo',
      branch: 'development',
    });
    manager.updateJob(job1.id, { status: 'analyzing' });
    // Handing job1 back would report branch "development" as the work being done
    // for a caller that asked for "main". Falling through to the single-slot
    // guard is the truthful answer.
    expect(() =>
      manager.createJob({ repoUrl: 'https://github.com/user/repo', branch: 'main' }),
    ).toThrow(/already in progress/);
  });

  it('treats an unpinned request as distinct from a branch-pinned one', () => {
    const job1 = manager.createJob({
      repoUrl: 'https://github.com/user/repo',
      branch: 'development',
    });
    manager.updateJob(job1.id, { status: 'analyzing' });
    expect(() => manager.createJob({ repoUrl: 'https://github.com/user/repo' })).toThrow(
      /already in progress/,
    );
  });

  it('keeps callers that omit branch deduping exactly as before', () => {
    // The parameter is optional, so every pre-existing call site (upload route,
    // embed manager, tests) compares undefined === undefined and is unaffected.
    const job1 = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    expect(manager.createJob({ repoPath: '/tmp/repo' }).id).toBe(job1.id);
  });

  it('carries the branch unchanged through the whole job lifecycle', () => {
    // `branch` is part of dedup identity, so it must not drift mid-flight.
    // `updateJob`'s Pick<> allowlist omits it, so no well-typed caller can
    // change it; this pins that none of the updates the server actually
    // performs (clone -> analyze -> terminal) disturbs it either.
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo', branch: 'develop' });
    manager.updateJob(job.id, { status: 'cloning' });
    manager.updateJob(job.id, { repoPath: '/tmp/repo', status: 'analyzing' });
    manager.updateJob(job.id, { progress: { phase: 'parsing', percent: 30, message: 'Parsing' } });
    manager.updateJob(job.id, { status: 'complete', repoName: 'repo' });
    expect(manager.getJob(job.id)?.branch).toBe('develop');
  });

  it('updates job progress', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing code' },
    });
    const updated = manager.getJob(job.id)!;
    expect(updated.status).toBe('analyzing');
    expect(updated.progress.percent).toBe(30);
  });

  it('emits progress events', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const events: any[] = [];
    manager.onProgress(job.id, (data) => events.push(data));

    manager.updateJob(job.id, {
      progress: { phase: 'parsing', percent: 50, message: 'Parsing code' },
    });

    expect(events).toHaveLength(1);
    expect(events[0].percent).toBe(50);
  });

  it('emits terminal event on complete', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const events: any[] = [];
    manager.onProgress(job.id, (data) => events.push(data));

    manager.updateJob(job.id, { status: 'complete', repoName: 'repo' });

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('complete');
    expect(events[0].percent).toBe(100);
  });

  it('sets completedAt on terminal status', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, { status: 'complete' });
    expect(manager.getJob(job.id)!.completedAt).toBeDefined();
  });

  it('unsubscribe stops events', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const events: any[] = [];
    const unsub = manager.onProgress(job.id, (data) => events.push(data));

    manager.updateJob(job.id, {
      progress: { phase: 'p1', percent: 10, message: 'm1' },
    });
    unsub();
    manager.updateJob(job.id, {
      progress: { phase: 'p2', percent: 20, message: 'm2' },
    });

    expect(events).toHaveLength(1);
  });

  it('cancelJob sets status to failed with reason', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });
    const cancelled = manager.cancelJob(job.id, 'Cancelled by user');
    expect(cancelled).toBe(true);
    expect(manager.getJob(job.id)!.status).toBe('failed');
    expect(manager.getJob(job.id)!.error).toBe('Cancelled by user');
  });

  it('cancelJob aborts registered in-process work', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });
    const controller = new AbortController();
    manager.registerAbortController(job.id, controller);

    manager.cancelJob(job.id, 'Cancelled by user');

    expect(controller.signal.aborted).toBe(true);
  });

  // Cancellation must reach the worker over IPC first. On Windows
  // `child.kill('SIGTERM')` is a forceful termination, so leading with the
  // signal could kill the worker mid LadybugDB write; the signal is only a
  // bounded fallback for a worker that ignores the cancel request.
  it('cancelJob asks the worker to stop over IPC before sending any signal', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    const sent: unknown[] = [];
    const signals: string[] = [];
    let onExit: (() => void) | undefined;
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: (msg: unknown) => {
        sent.push(msg);
        return true;
      },
      kill: (signal?: string) => {
        signals.push(signal ?? 'SIGTERM');
        return true;
      },
      on: (_event: string, listener: () => void) => {
        onExit = listener;
        return fakeChild;
      },
    };
    manager.registerChild(job.id, fakeChild as any);

    expect(manager.cancelJob(job.id, 'Cancelled by user')).toBe(true);

    expect(sent).toEqual([{ type: 'cancel' }]);
    expect(signals).toEqual([]);
    expect(manager.getJob(job.id)!.status).toBe('analyzing');
    onExit?.();
    expect(manager.getJob(job.id)!.status).toBe('failed');
    expect(manager.getJob(job.id)!.error).toBe('Cancelled by user');
  });

  it('cancelJob keeps the slot occupied until the worker exits', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    let onExit: (() => void) | undefined;
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: () => true,
      on: (_event: string, listener: () => void) => {
        onExit = listener;
        return fakeChild;
      },
    };
    manager.registerChild(job.id, fakeChild as any);

    expect(manager.cancelJob(job.id, 'Cancelled by user')).toBe(true);
    expect(manager.getJob(job.id)!.status).toBe('analyzing');
    expect(manager.hasPendingCancel(job.id)).toBe(true);
    expect(() => manager.createJob({ repoPath: '/tmp/other' })).toThrow(
      /Analysis already in progress/,
    );

    onExit?.();
    expect(manager.getJob(job.id)!.status).toBe('failed');
    expect(manager.hasPendingCancel(job.id)).toBe(false);
    expect(manager.createJob({ repoPath: '/tmp/other' }).status).toBe('queued');
  });

  it('createJob rejects same-repo reuse while a cancel is pending', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    let onExit: (() => void) | undefined;
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: () => true,
      on: (_event: string, listener: () => void) => {
        onExit = listener;
        return fakeChild;
      },
    };
    manager.registerChild(job.id, fakeChild as any);

    expect(manager.cancelJob(job.id, 'Cancelled by user')).toBe(true);
    expect(() => manager.createJob({ repoPath: '/tmp/repo' })).toThrow(
      /Analysis already in progress/,
    );
    expect(() => manager.createJob({ repoPath: '/tmp/other' })).toThrow(
      /Analysis already in progress/,
    );

    onExit?.();
    expect(manager.createJob({ repoPath: '/tmp/repo' }).status).toBe('queued');
  });

  it('createJob rejects same-repo reuse after cancel IPC is consumed but the child remains', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    let onExit: (() => void) | undefined;
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: () => true,
      on: (_event: string, listener: () => void) => {
        onExit = listener;
        return fakeChild;
      },
    };
    manager.registerChild(job.id, fakeChild as any);

    expect(manager.cancelJob(job.id, 'Cancelled by user')).toBe(true);
    expect(manager.applyPendingCancel(job.id)).toBe(true);
    expect(manager.getJob(job.id)?.status).toBe('failed');
    expect(manager.hasPendingCancel(job.id)).toBe(false);
    expect(() => manager.createJob({ repoPath: '/tmp/repo' })).toThrow(
      /Analysis already in progress/,
    );

    onExit?.();
    expect(manager.createJob({ repoPath: '/tmp/repo' }).status).toBe('queued');
  });

  it('applyPendingCancel writes the caller reason and ignores a later worker error', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: () => true,
      on: () => fakeChild,
    };
    manager.registerChild(job.id, fakeChild as any);

    expect(manager.cancelJob(job.id, 'Analysis timed out (30 minute limit)')).toBe(true);
    expect(manager.applyPendingCancel(job.id)).toBe(true);
    expect(manager.getJob(job.id)!.status).toBe('failed');
    expect(manager.getJob(job.id)!.error).toBe('Analysis timed out (30 minute limit)');
    expect(manager.hasPendingCancel(job.id)).toBe(false);

    manager.updateJob(job.id, {
      status: 'failed',
      error: 'Analysis cancelled (parent requested cancellation)',
    });
    expect(manager.getJob(job.id)!.error).toBe('Analysis timed out (30 minute limit)');
  });

  it('releaseChild frees the slot when a failed job never emits exit', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: () => true,
      on: () => fakeChild,
    };
    manager.registerChild(job.id, fakeChild as any);
    manager.updateJob(job.id, { status: 'failed', error: 'Worker process error: spawn ENOENT' });

    expect(() => manager.createJob({ repoPath: '/tmp/other' })).toThrow(/already in progress/);
    manager.releaseChild(job.id);
    expect(manager.createJob({ repoPath: '/tmp/other' }).status).toBe('queued');
  });

  it('cancelJob falls back to a signal when the IPC channel is already closed', () => {
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    const signals: string[] = [];
    // connected:false — requestChildShutdown skips send() and signal-kills.
    const fakeChild = {
      connected: false,
      exitCode: null,
      signalCode: null,
      kill: (signal?: string) => {
        signals.push(signal ?? 'SIGTERM');
        return true;
      },
      on: () => fakeChild,
    };
    manager.registerChild(job.id, fakeChild as any);

    manager.cancelJob(job.id);

    expect(signals).toEqual(['SIGTERM']);
  });

  it('cancelJob SIGKILLs after the grace period when the worker ignores IPC', () => {
    manager.dispose();
    vi.useFakeTimers();
    manager = new JobManager();
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    const signals: string[] = [];
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: (signal?: string) => {
        signals.push(signal ?? 'SIGTERM');
        return true;
      },
      on: () => fakeChild,
    };
    manager.registerChild(job.id, fakeChild as any);

    expect(manager.cancelJob(job.id)).toBe(true);
    expect(signals).toEqual([]);
    vi.advanceTimersByTime(15_000);
    expect(signals).toEqual(['SIGKILL']);
  });

  it('dispose on Windows skips immediate SIGTERM and leaves the IPC grace timer', () => {
    manager.dispose();
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    manager = new JobManager();
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    const signals: string[] = [];
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: (signal?: string) => {
        signals.push(signal ?? 'SIGTERM');
        return true;
      },
      on: () => fakeChild,
    };
    manager.registerChild(job.id, fakeChild as any);
    manager.dispose();

    expect(signals).toEqual([]);
    vi.advanceTimersByTime(15_000);
    expect(signals).toEqual(['SIGKILL']);
    vi.restoreAllMocks();
  });

  it('dispose on Unix SIGTERMs after IPC and clears the grace timer', () => {
    manager.dispose();
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    manager = new JobManager();
    const job = manager.createJob({ repoPath: '/tmp/repo' });
    manager.updateJob(job.id, { status: 'analyzing' });

    const signals: string[] = [];
    const fakeChild = {
      connected: true,
      exitCode: null,
      signalCode: null,
      send: () => true,
      kill: (signal?: string) => {
        signals.push(signal ?? 'SIGTERM');
        return true;
      },
      on: () => fakeChild,
    };
    manager.registerChild(job.id, fakeChild as any);
    manager.dispose();

    expect(signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(15_000);
    expect(signals).toEqual(['SIGTERM']);
    vi.restoreAllMocks();
  });

  it('cancelJob returns false for terminal jobs', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job.id, { status: 'complete' });
    expect(manager.cancelJob(job.id)).toBe(false);
  });

  it('cancelJob returns false for unknown job', () => {
    expect(manager.cancelJob('nonexistent')).toBe(false);
  });

  // #2264 P3: a job's terminal outcome is immutable, so a late worker message (a
  // SIGTERM-driven `error` after `complete`, or vice versa) cannot flip it.
  describe('terminal-state immutability (#2264 P3)', () => {
    it('keeps complete when a later failed update arrives', () => {
      const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
      manager.updateJob(job.id, { status: 'analyzing' });
      manager.updateJob(job.id, { status: 'complete', repoName: 'repo' });
      manager.updateJob(job.id, { status: 'failed', error: 'Analysis cancelled' });
      expect(manager.getJob(job.id)!.status).toBe('complete');
    });

    it('keeps failed when a later complete update arrives', () => {
      const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
      manager.updateJob(job.id, { status: 'analyzing' });
      manager.updateJob(job.id, { status: 'failed', error: 'Analysis cancelled' });
      manager.updateJob(job.id, { status: 'complete', repoName: 'repo' });
      const after = manager.getJob(job.id)!;
      expect(after.status).toBe('failed');
      expect(after.error).toBe('Analysis cancelled');
    });

    it('emits no further event for a post-terminal update', () => {
      const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
      const events: Array<{ phase: string }> = [];
      manager.onProgress(job.id, (data) => events.push(data));
      manager.updateJob(job.id, { status: 'complete', repoName: 'repo' });
      manager.updateJob(job.id, { status: 'failed', error: 'late' });
      expect(events).toHaveLength(1);
      expect(events[0].phase).toBe('complete');
    });
  });

  /**
   * #2790: terminality is a property of the job's STATUS, and a terminal
   * `failed` job may still have persisted usable work. The SSE relay reads both
   * — `isTerminalJobStatus` to decide the stream is over, `partial` to tell a
   * client "retry these N nodes" apart from "nothing worked".
   */
  describe('terminal status and partial outcomes (#2790)', () => {
    it('recognizes exactly the two settled statuses', () => {
      expect({
        queued: isTerminalJobStatus('queued'),
        cloning: isTerminalJobStatus('cloning'),
        analyzing: isTerminalJobStatus('analyzing'),
        loading: isTerminalJobStatus('loading'),
        complete: isTerminalJobStatus('complete'),
        failed: isTerminalJobStatus('failed'),
      }).toEqual({
        queued: false,
        cloning: false,
        analyzing: false,
        loading: false,
        complete: true,
        failed: true,
      });
    });

    const partial: AnalyzeJobPartialOutcome = {
      kind: 'embedding-partial',
      pendingNodeCount: 2,
      nodesProcessed: 10,
    };

    it('records a partial outcome on a failed job without changing its status', () => {
      const job = manager.createJob({ repoPath: '/tmp/embed-partial' });
      manager.updateJob(job.id, { status: 'analyzing' });
      manager.updateJob(job.id, {
        status: 'failed',
        error: 'Embedding generation finished partially: 2 node(s) lost their embeddings.',
        partial,
      });

      expect(manager.getJob(job.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('finished partially'),
        partial: { kind: 'embedding-partial', pendingNodeCount: 2, nodesProcessed: 10 },
      });
    });

    it('leaves a clean job with no partial marker at all', () => {
      const job = manager.createJob({ repoPath: '/tmp/embed-clean' });
      manager.updateJob(job.id, { status: 'analyzing' });
      manager.updateJob(job.id, { status: 'complete' });

      // Absent, not `null`/`false` — JSON.stringify omits it, so the wire shape
      // of every non-partial job is unchanged.
      expect(manager.getJob(job.id)).toMatchObject({ status: 'complete' });
      expect(manager.getJob(job.id)?.partial).toBeUndefined();
    });

    it('still emits exactly one terminal event when a partial outcome is attached', () => {
      const job = manager.createJob({ repoPath: '/tmp/embed-partial' });
      const events: Array<{ phase: string; message: string }> = [];
      manager.updateJob(job.id, { status: 'analyzing' });
      manager.onProgress(job.id, (data) => events.push(data));
      manager.updateJob(job.id, {
        status: 'failed',
        error: 'Embedding generation finished partially: 2 node(s) lost their embeddings.',
        partial,
        progress: { phase: 'failed', percent: 100, message: 'partial' },
      });

      expect(events).toEqual([
        { phase: 'failed', percent: 100, message: expect.stringContaining('finished partially') },
      ]);
    });
  });
});
