/**
 * The finalization gate must watch the index the run actually WROTE.
 *
 * `registerRepo` always records the flat `.gitnexus` as `entry.storagePath`, but
 * a pinned `--branch` run whose label differs from the flat slot's owner writes
 * `lbug`/`gitnexus.json` under `branches/<slug>/`. The gate used to probe the
 * flat path unconditionally, so for such a run it watched files this job never
 * rewrote:
 *
 *   - the gate never settles, so the job stays non-terminal for the full 60s;
 *   - meanwhile the worker, having already sent `complete`, calls
 *     `process.exit(0)` ~500ms later;
 *   - the exit handler saw a non-terminal job and classified that clean exit as
 *     a crash — retrying a SUCCESSFUL analysis three times before failing it
 *     with `Worker crashed 3 times (code 0)`.
 *
 * Reported twice on #3199 (maintainer review + @azizur100389's repro). These
 * tests pin both halves: the gate follows the placement, and a terminal IPC
 * makes a subsequent exit 0 settlement rather than a crash.
 *
 * The filesystem mock is deliberately PATH-SENSITIVE — only the branch sub-slot
 * looks freshly written. A gate that probes the flat path therefore cannot pass
 * these tests by accident.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

// `vi.hoisted` is lifted above the imports, so nothing in here may reference
// them — these stay plain literals and `path` is only used below.
const H = vi.hoisted(() => ({
  forkMock: vi.fn(),
  mayEmbed: vi.fn(async () => false),
  STORAGE_PATH: '/tmp/gitnexus-settle-storage',
  REPO_PATH: '/tmp/gitnexus-settle-repo',
  METADATA_FILE: 'gitnexus.json',
  // Set per-test: the only directory the fake filesystem reports as freshly
  // written. Anything else looks stale, exactly like a slot this job skipped.
  settledDir: '',
  graphFile: 'lbug',
}));
const { forkMock, REPO_PATH } = H;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, fork: H.forkMock };
});

vi.mock('../../src/core/analysis-host-resources.js', async () => {
  const { resolveAnalysisResourceBudget } =
    await import('../../src/core/analysis-resource-budget.js');
  return {
    analysisMayEmbed: H.mayEmbed,
    analysisSupervisorReservation: () => 192 * 1024 ** 2,
    resolveHostAnalysisResources: () =>
      resolveAnalysisResourceBudget({
        effectiveMemoryBytes: 4096 * 1024 ** 2,
        availableCpus: 2,
        modelMemoryMb: 0,
      }),
  };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  INDEX_METADATA_FILE: H.METADATA_FILE,
}));

vi.mock('../../src/storage/storage-resolver.js', () => ({
  ANALYZE_STORAGE_REQUIREMENTS: { allowedStates: ['missing', 'empty', 'owned'] },
  ANALYZE_FORCE_STORAGE_REQUIREMENTS: {
    allowedStates: ['missing', 'empty', 'owned', 'unowned', 'foreign'],
  },
  requireStoragePath: async () => H.STORAGE_PATH,
}));

vi.mock('../../src/storage/shared-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/shared-store.js')>();
  return { ...actual, resolveGraphPath: (slot: string) => `${slot}/${H.graphFile}` };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    statSync: (p: string) => {
      // Fresh only inside the directory this run is pretending to have written.
      // Plain string work rather than `path.dirname`: this factory is hoisted
      // above the imports too.
      const file = String(p);
      const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
      if (H.settledDir && dir === H.settledDir) {
        if (!file.endsWith(H.METADATA_FILE) && !file.endsWith(H.graphFile))
          throw Object.assign(new Error('Retired graph name'), { code: 'ENOENT' });
        return { mtimeMs: Number.MAX_SAFE_INTEGER };
      }
      return { mtimeMs: 0 };
    },
    existsSync: () => false, // no WAL/shadow/checkpoint sidecars anywhere
  };
});

import { createLaunchAnalysisWorker } from '../../src/server/analyze-launch.js';
import { JobManager } from '../../src/server/analyze-job.js';
import { projectAnalyzeResultForIpc } from '../../src/server/analyze-worker-ipc.js';
import { BRANCHES_DIR, branchSlug } from '../../src/storage/branch-index.js';
import type { AnalyzeResult } from '../../src/core/run-analyze.js';
import type { CompleteMessage } from '../../src/server/analyze-worker.js';

const BRANCH = 'feature/settle';

/** The `complete` message the worker really sends, via the production projection. */
const completeMessage = (
  isPrimaryBranch: boolean,
  extras?: { alreadyUpToDate?: boolean },
): CompleteMessage => {
  const result = {
    repoName: 'settle-fixture',
    repoPath: REPO_PATH,
    stats: { files: 3, nodes: 9, edges: 12 },
    isPrimaryBranch,
    ...(extras?.alreadyUpToDate ? { alreadyUpToDate: true } : {}),
  } satisfies Partial<AnalyzeResult> as AnalyzeResult;
  return { type: 'complete', result: projectAnalyzeResultForIpc(result) };
};

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  send: Mock<(msg: unknown) => boolean>;
  kill: Mock<(signal?: NodeJS.Signals) => boolean>;
}

const makeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  child.send = vi.fn();
  child.kill = vi.fn();
  return child;
};

describe('finalization gate follows the placement the run chose', () => {
  let jobManager: JobManager;
  let child: FakeChild;
  let backendInit: Mock<() => Promise<unknown>>;
  let closeDbHandle: Mock<() => Promise<void>>;

  const launcher = (extras?: { releaseRepoLock?: () => void }) =>
    createLaunchAnalysisWorker({
      jobManager,
      backend: { init: backendInit },
      acquireRepoLock: () => null,
      releaseRepoLock: extras?.releaseRepoLock ?? (() => {}),
      closeDbHandle,
    });

  beforeEach(() => {
    jobManager = new JobManager();
    H.mayEmbed.mockResolvedValue(false);
    child = makeChild();
    forkMock.mockImplementation(() => child);
    backendInit = vi.fn(async () => true);
    closeDbHandle = vi.fn(async () => {});
    H.settledDir = '';
    H.graphFile = 'lbug';
  });

  afterEach(() => {
    vi.useRealTimers();
    jobManager.dispose();
    vi.restoreAllMocks();
    forkMock.mockReset();
  });

  it('does not fork when resource preflight finishes after the job deadline', async () => {
    jobManager.dispose();
    vi.useFakeTimers();
    jobManager = new JobManager();
    let finish!: (value: boolean) => void;
    H.mayEmbed.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const job = jobManager.createJob({ repoPath: REPO_PATH });
    const pending = launcher()(job, REPO_PATH, {});
    vi.advanceTimersByTime(30 * 60_000);
    expect(jobManager.getJob(job.id)?.status).toBe('failed');
    expect(jobManager.createJob({ repoPath: '/tmp/next' }).status).toBe('queued');
    finish(false);
    await pending;
    expect(forkMock).not.toHaveBeenCalled();
    expect(backendInit).not.toHaveBeenCalled();
  });

  it('keeps graph readiness and embedding counters nonterminal across worker log messages', async () => {
    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher()(job, REPO_PATH, {});
    const embeddingProgress = {
      phase: 'embedding',
      totalNodes: 3,
      completedNodes: 1,
      reusedNodes: 1,
      pendingNodes: 1,
      failedNodes: 0,
      activeUnit: 0,
      chunks: 2,
    };
    child.emit('message', {
      type: 'progress',
      phase: 'embedding',
      percent: 70,
      message: 'Embedding',
      graphPhase: 'ready',
      embeddingProgress: { ...embeddingProgress, source: '/private/source', token: 1n },
      modelDownloadPercent: 100,
    });
    expect(jobManager.getJob(job.id)?.status).toBe('analyzing');
    expect(jobManager.getJob(job.id)?.progress).toMatchObject({
      graphPhase: 'ready',
      embeddingProgress,
      modelDownloadPercent: 100,
    });
    expect(JSON.stringify(jobManager.getJob(job.id)?.progress)).not.toContain('/private');
    child.emit('message', {
      type: 'progress',
      phase: 'log',
      percent: -1,
      message: 'Native checkpoint',
    });
    expect(jobManager.getJob(job.id)?.progress).toEqual({
      phase: 'log',
      percent: -1,
      message: 'Native checkpoint',
      graphPhase: 'ready',
      embeddingProgress,
      modelDownloadPercent: 100,
    });
    expect(jobManager.getJob(job.id)?.status).toBe('analyzing');
    expect(backendInit).not.toHaveBeenCalled();
  });

  it('completes a branch sub-slot run, whose files are NOT in the flat slot', async () => {
    // Only `branches/<slug>/` looks written. The flat slot is stale, so a gate
    // probing it would spin to the 60s timeout instead of settling here.
    H.settledDir = path.join(H.STORAGE_PATH, BRANCHES_DIR, branchSlug(BRANCH));

    const job = jobManager.createJob({ repoPath: REPO_PATH, branch: BRANCH });
    await launcher()(job, REPO_PATH, { branch: BRANCH });

    child.emit('message', completeMessage(false));
    child.emit('exit', 0);
    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    expect(backendInit).toHaveBeenCalledTimes(1);
  });

  it('still settles a flat-slot run against the flat slot', async () => {
    // Control: the primary-branch case must keep watching `entry.storagePath`.
    H.settledDir = H.STORAGE_PATH;

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher()(job, REPO_PATH, {});

    child.emit('message', completeMessage(true));
    child.emit('exit', 0);
    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(backendInit).toHaveBeenCalledTimes(1);
  });

  it('settles an FTS-only repair of a published private generation', async () => {
    vi.useFakeTimers();
    H.settledDir = H.STORAGE_PATH;
    H.graphFile = `lbug.generation.${'a'.repeat(32)}`;
    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher()(job, REPO_PATH, {});
    const message = completeMessage(true);
    message.result.ftsRepairedOnly = true;
    child.emit('message', message);
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(jobManager.getJob(job.id)?.status).toBe('complete');
    expect(backendInit).toHaveBeenCalledOnce();
  });

  it('completes resumed vectors after graph visibility and actual worker exit without rewriting the graph', async () => {
    vi.useFakeTimers();
    const releaseRepoLock = vi.fn();
    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher({ releaseRepoLock })(job, REPO_PATH, { embeddings: true });
    child.emit('message', { type: 'graph-ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(child.send).toHaveBeenCalledWith({ type: 'graph-visible' });
    child.emit('message', completeMessage(true));
    expect(jobManager.getJob(job.id)?.status).toBe('analyzing');
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(jobManager.getJob(job.id)?.status).toBe('complete');
    expect(releaseRepoLock).toHaveBeenCalledOnce();
  });

  it('settles a first-pin (branch SET, isPrimaryBranch true) against the flat slot', async () => {
    // Fresh clone: first pin adopts the flat slot. The slug dir is stale, so a
    // gate that does `branch ? slugDir : flat` would spin the 60s timeout here.
    H.settledDir = H.STORAGE_PATH;

    const job = jobManager.createJob({ repoPath: REPO_PATH, branch: BRANCH });
    await launcher()(job, REPO_PATH, { branch: BRANCH });

    child.emit('message', completeMessage(true));
    child.emit('exit', 0);
    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    expect(backendInit).toHaveBeenCalledTimes(1);
  });

  it('completes alreadyUpToDate quickly even when the slot is stale, without retrying', async () => {
    // No directory looks freshly written. Without the alreadyUpToDate skip the
    // mtime gate would hold the analyze slot for the full 60s settle timeout.
    H.settledDir = '';
    const releaseRepoLock = vi.fn();

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher({ releaseRepoLock })(job, REPO_PATH, {});

    child.emit('message', completeMessage(true, { alreadyUpToDate: true }));
    child.emit('exit', 0);

    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'), {
      timeout: 2_000,
    });
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    expect(backendInit).toHaveBeenCalledTimes(1);
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(jobManager.getJob(job.id)?.retryCount).toBe(0);
    // Short path: skip the mtime wait, then drop the lock once it finishes.
    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
  });

  it('does not fork a retry when the worker exits 0 after reporting complete', async () => {
    // The worker exits ~500ms after the `complete` IPC, while the gate is still
    // running and the job is deliberately non-terminal. That exit is the worker
    // winding down, not dying.
    H.settledDir = path.join(H.STORAGE_PATH, BRANCHES_DIR, branchSlug(BRANCH));

    const job = jobManager.createJob({ repoPath: REPO_PATH, branch: BRANCH });
    await launcher()(job, REPO_PATH, { branch: BRANCH });

    child.emit('message', completeMessage(false));
    child.emit('exit', 0);

    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    // One fork for the run itself; a retry would be a second.
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(jobManager.getJob(job.id)?.retryCount).toBe(0);
  });

  it('fails and does not publish when the settle gate times out', async () => {
    vi.useFakeTimers();
    H.settledDir = '';
    const releaseRepoLock = vi.fn();

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher({ releaseRepoLock })(job, REPO_PATH, {});
    child.emit('message', completeMessage(true));

    expect(releaseRepoLock).not.toHaveBeenCalled();
    expect(backendInit).not.toHaveBeenCalled();
    expect(jobManager.getJob(job.id)?.status).toBe('analyzing');

    // Must match FINALIZE_SETTLE_TIMEOUT_MS + one poll in analyze-launch.ts.
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(61_000);

    const done = jobManager.getJob(job.id);
    expect(done?.status).toBe('failed');
    expect(done?.error).toMatch(/finalization not visible after timeout/i);
    expect(backendInit).not.toHaveBeenCalled();
    expect(closeDbHandle).not.toHaveBeenCalled();
    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
  });

  it('aborts settle on cancel without waiting for the 60s timeout', async () => {
    vi.useFakeTimers();
    H.settledDir = '';
    const releaseRepoLock = vi.fn();

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher({ releaseRepoLock })(job, REPO_PATH, {});
    child.emit('message', completeMessage(true));
    child.emit('exit', 0);

    expect(jobManager.getJob(job.id)?.status).toBe('analyzing');
    jobManager.cancelJob(job.id, 'Cancelled by user');

    // One poll: shouldAbort sees pending cancel and returns without the
    // timeout warning / "finalization not visible" failure.
    await vi.advanceTimersByTimeAsync(200);

    const done = jobManager.getJob(job.id);
    expect(done?.status).toBe('failed');
    expect(done?.error).toBe('Cancelled by user');
    expect(done?.error).not.toMatch(/finalization not visible/);
    expect(backendInit).not.toHaveBeenCalled();
    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
  });

  it('does not release the lock or publish if cancel lands during settle', async () => {
    vi.useFakeTimers();
    H.settledDir = '';
    const releaseRepoLock = vi.fn();

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher({ releaseRepoLock })(job, REPO_PATH, {});
    child.emit('message', completeMessage(true));
    child.emit('exit', 0);

    expect(jobManager.getJob(job.id)?.status).toBe('analyzing');
    jobManager.cancelJob(job.id, 'Cancelled by user');

    expect(jobManager.getJob(job.id)?.status).toBe('failed');
    expect(releaseRepoLock).not.toHaveBeenCalled();
    expect(backendInit).not.toHaveBeenCalled();

    H.settledDir = H.STORAGE_PATH;
    await vi.advanceTimersByTimeAsync(200);

    expect(backendInit).not.toHaveBeenCalled();
    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
    expect(jobManager.getJob(job.id)?.status).toBe('failed');
  });

  it('holds the write lock until settle resolves, then releases once after publish', async () => {
    vi.useFakeTimers();
    H.settledDir = '';
    const order: string[] = [];
    const releaseRepoLock = vi.fn(() => {
      order.push('releaseRepoLock');
    });
    backendInit = vi.fn(async () => {
      order.push('backend.init');
      return true;
    });

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher({ releaseRepoLock })(job, REPO_PATH, {});
    child.emit('message', completeMessage(true));

    expect(releaseRepoLock).not.toHaveBeenCalled();
    expect(backendInit).not.toHaveBeenCalled();
    expect(jobManager.getJob(job.id)?.status).toBe('analyzing');

    H.settledDir = H.STORAGE_PATH;
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(200);

    expect(jobManager.getJob(job.id)?.status).toBe('complete');
    expect(backendInit).toHaveBeenCalledTimes(1);
    expect(releaseRepoLock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['backend.init', 'releaseRepoLock']);
  });

  it.each(['before-exit', 'during-retry'] as const)(
    'does not restart a worker when shutdown begins %s',
    async (when) => {
      vi.useFakeTimers();
      const releaseRepoLock = vi.fn();
      const job = jobManager.createJob({ repoPath: REPO_PATH });
      await launcher({ releaseRepoLock })(job, REPO_PATH, {});

      if (when === 'before-exit') jobManager.dispose();
      child.emit('exit', 1);
      if (when === 'during-retry') jobManager.dispose();
      await jobManager.waitForChildren();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(forkMock).toHaveBeenCalledTimes(1);
      expect(jobManager.getJob(job.id)?.status).toBe('failed');
      expect(jobManager.getJob(job.id)?.error).toBe('Server shutting down');
      expect(releaseRepoLock).toHaveBeenCalledTimes(1);
    },
  );

  it('still treats an exit with no terminal IPC as a crash worth retrying', async () => {
    // The guard must not swallow real crashes: no `complete`/`error` was sent.
    H.settledDir = H.STORAGE_PATH;

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    await launcher()(job, REPO_PATH, {});

    child.emit('exit', 1);

    // The first retry is scheduled on a 1s backoff, so this needs more than
    // vi.waitFor's default budget.
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    expect(jobManager.getJob(job.id)?.retryCount).toBe(1);
  });
});
