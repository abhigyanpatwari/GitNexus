/**
 * `createLaunchAnalysisWorker`'s collapsed-index guard — ORDERING, not just status.
 *
 * `backend.init()` is the PUBLISH step (it is `LocalBackend.refreshRepos()`,
 * which swaps the freshly-registered repo into the in-memory map every MCP tool
 * and HTTP route resolves through). The guard added in #2899 read
 * `graphWriteCollapsed` only AFTER that call had already resolved, so a
 * known-incomplete database was live and queryable before the job was ever
 * marked `failed` — the job status was a label on a published index rather than
 * a gate. These tests pin the order, because the order is the defect.
 *
 * `analyze-launch.ts` had ZERO test coverage before this file, which is why a
 * field-name drift against `analyze-worker-ipc.ts`'s wire shape would have made
 * the branch permanently dead and silently restored the pre-guard behaviour.
 * The worker messages below are therefore built by calling the PRODUCTION
 * projection `projectAnalyzeResultForIpc` rather than hand-rolling a literal, so
 * a rename of `graphWriteCollapsed` breaks these tests instead of disabling the
 * branch they cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';

// `vi.mock` factories are hoisted above every top-level `const`, and this file
// imports the module under test statically — so anything a factory closes over
// must be hoisted with it.
const H = vi.hoisted(() => ({
  forkMock: vi.fn(),
  STORAGE_PATH: '/tmp/gitnexus-test-storage',
  REPO_PATH: '/tmp/gitnexus-test-repo',
  METADATA_FILE: 'gitnexus.json',
}));
const { forkMock, REPO_PATH } = H;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, fork: H.forkMock };
});

// The launcher's finalization gate (`waitForSettledIndex`) probes the registry
// and the filesystem. Pin both so the gate settles on its FIRST poll — the gate
// itself is not under test here and its 200ms poll would otherwise put a real
// timer between the worker message and the assertions.
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
    // Both index files were (re)written far in the future relative to jobStartMs…
    statSync: () => ({ mtimeMs: Number.MAX_SAFE_INTEGER }),
    // …and no WAL/shadow/checkpoint sidecar remains.
    existsSync: () => false,
  };
});

import { createLaunchAnalysisWorker } from '../../src/server/analyze-launch.js';
import { JobManager } from '../../src/server/analyze-job.js';
import { projectAnalyzeResultForIpc } from '../../src/server/analyze-worker-ipc.js';
import type { AnalyzeResult } from '../../src/core/run-analyze.js';
import type { CompleteMessage } from '../../src/server/analyze-worker.js';

const REPO_NAME = 'collapse-fixture';

/**
 * Build the exact `complete` message the worker puts on the wire, by running the
 * production projection. The `graphWriteCollapsed` key is therefore whatever
 * `analyze-worker-ipc.ts` actually sends — not a literal this test invented.
 */
const completeMessage = (graphWriteCollapsed?: { expected: number; persisted: number }) => {
  const result = {
    repoName: REPO_NAME,
    repoPath: REPO_PATH,
    stats: { files: 10, nodes: 100, edges: 500 },
    ...(graphWriteCollapsed ? { graphWriteCollapsed } : {}),
  } satisfies Partial<AnalyzeResult> as AnalyzeResult;
  return { type: 'complete', result: projectAnalyzeResultForIpc(result) } satisfies CompleteMessage;
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

describe('createLaunchAnalysisWorker — collapsed index is never published', () => {
  let jobManager: JobManager;
  let child: FakeChild;
  let calls: string[];
  let backendInit: Mock<() => Promise<unknown>>;
  let closeDbHandle: Mock<() => Promise<void>>;

  /** Drive one analyze to its terminal state and return the observed call order. */
  const runWorker = async (msg: CompleteMessage) => {
    const launch = createLaunchAnalysisWorker({
      jobManager,
      backend: { init: backendInit },
      acquireRepoLock: () => null,
      releaseRepoLock: () => {},
      closeDbHandle,
    });

    const job = jobManager.createJob({ repoPath: REPO_PATH });
    launch(job, REPO_PATH, {});
    child.emit('message', msg);

    await vi.waitFor(() => expect(calls).toContain('updateJob:terminal'));
    return jobManager.getJob(job.id);
  };

  beforeEach(() => {
    calls = [];
    jobManager = new JobManager();
    child = makeChild();
    forkMock.mockImplementation(() => child);

    backendInit = vi.fn(async () => {
      calls.push('backend.init');
      return true;
    });
    closeDbHandle = vi.fn(async () => {
      calls.push('closeDbHandle');
    });

    const realUpdate = jobManager.updateJob.bind(jobManager);
    vi.spyOn(jobManager, 'updateJob').mockImplementation((id, update) => {
      calls.push(`updateJob:${update.status ?? 'progress'}`);
      realUpdate(id, update);
      // Recorded after the real call so the marker only lands once the status is
      // committed — `updateJob` drops any update to an already-terminal job.
      calls.push(
        ...['complete', 'failed']
          .filter((s) => s === update.status)
          .map(() => 'updateJob:terminal'),
      );
    });
  });

  it('forwards the Spring Actuator snapshot path to the worker', () => {
    const launch = createLaunchAnalysisWorker({
      jobManager,
      backend: { init: backendInit },
      acquireRepoLock: () => null,
      releaseRepoLock: () => {},
      closeDbHandle,
    });
    const job = jobManager.createJob({ repoPath: REPO_PATH });

    launch(job, REPO_PATH, { springActuatorPath: 'runtime/actuator' });

    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          springActuatorPath: 'runtime/actuator',
        }),
      }),
    );
  });

  it('forwards the index-branch selector to the worker', () => {
    const launch = createLaunchAnalysisWorker({
      jobManager,
      backend: { init: backendInit },
      acquireRepoLock: () => null,
      releaseRepoLock: () => {},
      closeDbHandle,
    });
    const job = jobManager.createJob({ repoPath: REPO_PATH });

    launch(job, REPO_PATH, { branch: 'development' });

    // `StartMessage.options` is typed as `AnalyzeOptions`, so this key IS
    // `AnalyzeOptions.branch` — the field `resolveWriteTarget` reads to pin the
    // run to `branches/<slug>/`. A rename there breaks this test.
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ branch: 'development' }),
      }),
    );
  });

  it('omits branch entirely when the caller did not select one', () => {
    const launch = createLaunchAnalysisWorker({
      jobManager,
      backend: { init: backendInit },
      acquireRepoLock: () => null,
      releaseRepoLock: () => {},
      closeDbHandle,
    });
    const job = jobManager.createJob({ repoPath: REPO_PATH });

    launch(job, REPO_PATH, {});

    // Not merely undefined: absent. `AnalyzeOptions.branch === undefined` is the
    // documented signal for "target the flat workspace slot", so sending the key
    // with an undefined value must not become the way that default is expressed.
    const sent = child.send.mock.calls.at(0)?.[0] as { options: Record<string, unknown> };
    expect(Object.hasOwn(sent.options, 'branch')).toBe(false);
  });

  afterEach(() => {
    jobManager.dispose();
    vi.restoreAllMocks();
    forkMock.mockReset();
  });

  it('does not publish the index — backend.init() is never called for a collapsed run', async () => {
    await runWorker(completeMessage({ expected: 500, persisted: 3 }));

    // The defect: init() resolved FIRST, so the incomplete graph was live and
    // queryable by every MCP/API consumer before the job was marked failed.
    expect(backendInit).not.toHaveBeenCalled();
    expect(calls).not.toContain('backend.init');
    // The cached handle is still evicted — the worker rewrote the DB files on
    // disk, so a pre-rewrite handle is stale whatever the outcome was. Eviction
    // is not publication.
    expect(closeDbHandle).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('closeDbHandle')).toBeLessThan(calls.indexOf('updateJob:failed'));
  });

  it('marks the collapsed run failed and still reports repoName', async () => {
    const job = await runWorker(completeMessage({ expected: 500, persisted: 3 }));

    expect(job?.status).toBe('failed');
    // The success path sets repoName; api.ts's repo-resolution wait matches jobs
    // on it first. Dropping it here cost one of three match keys for no reason.
    expect(job?.repoName).toBe(REPO_NAME);
    expect(job?.error).toContain('INCOMPLETELY');
    expect(job?.error).toContain('3 of 500');
    // The failure is explicit about the index being unreachable, not merely stale.
    expect(job?.error).toContain('NOT published');
  });

  it('publishes and completes a healthy run, in that order', async () => {
    const job = await runWorker(completeMessage());

    expect(job?.status).toBe('complete');
    expect(job?.repoName).toBe(REPO_NAME);
    expect(backendInit).toHaveBeenCalledTimes(1);
    // Publish strictly BEFORE the terminal complete, so the repo really is
    // queryable when the client receives the SSE complete event.
    expect(calls).toEqual([
      'updateJob:analyzing',
      'closeDbHandle',
      'backend.init',
      'updateJob:complete',
      'updateJob:terminal',
    ]);
  });

  it('reads the collapse flag under the name analyze-worker-ipc.ts actually sends', async () => {
    const wire = completeMessage({ expected: 500, persisted: 3 });

    // Guards against a silent rename: the branch under test keys off this exact
    // field, and the message was produced by the production projection.
    expect(Object.keys(wire.result)).toContain('graphWriteCollapsed');
    expect(wire.result.graphWriteCollapsed).toEqual({ expected: 500, persisted: 3 });

    // A projection that stopped carrying the field must not read as healthy.
    const healthy = completeMessage();
    expect(healthy.result.graphWriteCollapsed).toBeUndefined();
    const job = await runWorker(healthy);
    expect(job?.status).toBe('complete');
  });
});
