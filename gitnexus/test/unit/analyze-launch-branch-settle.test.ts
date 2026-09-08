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
  STORAGE_PATH: '/tmp/gitnexus-settle-storage',
  REPO_PATH: '/tmp/gitnexus-settle-repo',
  METADATA_FILE: 'gitnexus.json',
  // Set per-test: the only directory the fake filesystem reports as freshly
  // written. Anything else looks stale, exactly like a slot this job skipped.
  settledDir: '',
}));
const { forkMock, REPO_PATH } = H;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, fork: H.forkMock };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  canonicalizePath: (p: string) => p,
  getStoragePath: () => H.STORAGE_PATH,
  INDEX_METADATA_FILE: H.METADATA_FILE,
  listRegisteredRepos: async () => [{ path: H.REPO_PATH, storagePath: H.STORAGE_PATH }],
  registryPathEquals: (a: string, b: string) => a === b,
}));

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

  const launcher = () =>
    createLaunchAnalysisWorker({
      jobManager,
      backend: { init: backendInit },
      acquireRepoLock: () => null,
      releaseRepoLock: () => {},
      closeDbHandle,
    });

  beforeEach(() => {
    jobManager = new JobManager();
    child = makeChild();
    forkMock.mockImplementation(() => child);
    backendInit = vi.fn(async () => true);
    closeDbHandle = vi.fn(async () => {});
    H.settledDir = '';
  });

  afterEach(() => {
    jobManager.dispose();
    vi.restoreAllMocks();
    forkMock.mockReset();
  });

  it('completes a branch sub-slot run, whose files are NOT in the flat slot', async () => {
    // Only `branches/<slug>/` looks written. The flat slot is stale, so a gate
    // probing it would spin to the 60s timeout instead of settling here.
    H.settledDir = path.join(H.STORAGE_PATH, BRANCHES_DIR, branchSlug(BRANCH));

    const job = jobManager.createJob({ repoPath: REPO_PATH, branch: BRANCH });
    launcher()(job, REPO_PATH, { branch: BRANCH });

    child.emit('message', completeMessage(false));

    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    expect(backendInit).toHaveBeenCalledTimes(1);
  });

  it('still settles a flat-slot run against the flat slot', async () => {
    // Control: the primary-branch case must keep watching `entry.storagePath`.
    H.settledDir = H.STORAGE_PATH;

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    launcher()(job, REPO_PATH, {});

    child.emit('message', completeMessage(true));

    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(backendInit).toHaveBeenCalledTimes(1);
  });

  it('settles a first-pin (branch SET, isPrimaryBranch true) against the flat slot', async () => {
    // Fresh clone: first pin adopts the flat slot. The slug dir is stale, so a
    // gate that does `branch ? slugDir : flat` would spin the 60s timeout here.
    H.settledDir = H.STORAGE_PATH;

    const job = jobManager.createJob({ repoPath: REPO_PATH, branch: BRANCH });
    launcher()(job, REPO_PATH, { branch: BRANCH });

    child.emit('message', completeMessage(true));

    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    expect(backendInit).toHaveBeenCalledTimes(1);
  });

  it('completes alreadyUpToDate quickly even when the slot is stale, without retrying', async () => {
    // No directory looks freshly written. Without the alreadyUpToDate skip the
    // mtime gate would hold the analyze slot for the full 60s settle timeout.
    H.settledDir = '';

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    launcher()(job, REPO_PATH, {});

    child.emit('message', completeMessage(true, { alreadyUpToDate: true }));
    child.emit('exit', 0);

    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'), {
      timeout: 2_000,
    });
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    expect(backendInit).toHaveBeenCalledTimes(1);
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(jobManager.getJob(job.id)?.retryCount).toBe(0);
  });

  it('does not fork a retry when the worker exits 0 after reporting complete', async () => {
    // The worker exits ~500ms after the `complete` IPC, while the gate is still
    // running and the job is deliberately non-terminal. That exit is the worker
    // winding down, not dying.
    H.settledDir = path.join(H.STORAGE_PATH, BRANCHES_DIR, branchSlug(BRANCH));

    const job = jobManager.createJob({ repoPath: REPO_PATH, branch: BRANCH });
    launcher()(job, REPO_PATH, { branch: BRANCH });

    child.emit('message', completeMessage(false));
    child.emit('exit', 0);

    await vi.waitFor(() => expect(jobManager.getJob(job.id)?.status).toBe('complete'));
    expect(jobManager.getJob(job.id)?.error).toBeUndefined();
    // One fork for the run itself; a retry would be a second.
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(jobManager.getJob(job.id)?.retryCount).toBe(0);
  });

  it('still treats an exit with no terminal IPC as a crash worth retrying', async () => {
    // The guard must not swallow real crashes: no `complete`/`error` was sent.
    H.settledDir = H.STORAGE_PATH;

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    launcher()(job, REPO_PATH, {});

    child.emit('exit', 1);

    // The first retry is scheduled on a 1s backoff, so this needs more than
    // vi.waitFor's default budget.
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    expect(jobManager.getJob(job.id)?.retryCount).toBe(1);
  });
});
