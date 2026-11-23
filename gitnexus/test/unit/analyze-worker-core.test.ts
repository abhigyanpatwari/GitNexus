/**
 * Unit tests for the analyze-worker core seam (#2264).
 *
 * P2: the worker must NOT report `complete` for a half-finalized repo (meta.json
 * written but the global registry entry missing) — it must surface that as an
 * error, mirroring the CLI's assertAnalysisFinalized guard.
 *
 * P3: a SIGTERM cancellation and a near-simultaneous completion must not both
 * report a terminal outcome — the `claimTerminal` slot coordinates them.
 *
 * Driven via the side-effect-free `runWorkerAnalysis` seam with injected fakes, so
 * no fork()/process.on side effects of the entry module are touched.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runWorkerAnalysis,
  createTerminalClaim,
  type WorkerAnalysisDeps,
} from '../../src/server/analyze-worker-core.js';
import type { AnalyzeResult } from '../../src/core/run-analyze.js';
import type { WorkerMessage } from '../../src/server/analyze-worker.js';
import type { AnalyzerRunnerIdentity } from '../../src/storage/repo-manager.js';
import type { AnalysisPhaseProgress } from '../../src/core/analysis-progress.js';
import { IndexLockTimeoutError, type LockRecord } from '../../src/storage/index-lock.js';

const baseResult: AnalyzeResult = {
  rebuildReasons: [],
  repoName: 'repo',
  repoPath: '/repo',
  storagePath: '/repo/.gitnexus',
  stats: {},
  alreadyUpToDate: false,
  ftsRepairedOnly: false,
};

const okRun: WorkerAnalysisDeps['runFullAnalysis'] = vi.fn(async () => baseResult);
const okFinalize: WorkerAnalysisDeps['assertAnalysisFinalized'] = vi.fn(async () => undefined);
const alwaysClaim: WorkerAnalysisDeps['claimTerminal'] = () => true;

it('carries bounded phase progress over worker IPC without serializing internal fields', async () => {
  const send = vi.fn<(msg: WorkerMessage) => void>((message) => {
    JSON.stringify(message);
  });
  const embeddingProgress = {
    phase: 'embedding' as const,
    totalNodes: 3,
    completedNodes: 1,
    reusedNodes: 1,
    pendingNodes: 1,
    failedNodes: 0,
    activeUnit: 0,
    chunks: 2,
  };
  const details = {
    graphPhase: 'ready',
    embeddingProgress: { ...embeddingProgress, identity: 1n },
    modelDownloadPercent: 25,
    sourcePath: '/private/source',
    native: 1n,
  } as unknown as AnalysisPhaseProgress;
  await runWorkerAnalysis(
    '/repo',
    {},
    {
      runFullAnalysis: vi.fn(async (_repo, _options, callbacks) => {
        callbacks.onProgress('embedding', 70, 'Embedding current selection', details);
        return baseResult;
      }),
      assertAnalysisFinalized: okFinalize,
      claimTerminal: alwaysClaim,
      send,
    },
  );
  expect(
    send.mock.calls.filter(([message]) => message.type === 'progress').map(([message]) => message),
  ).toEqual([
    {
      type: 'progress',
      phase: 'embedding',
      percent: 70,
      message: 'Embedding current selection',
      graphPhase: 'ready',
      embeddingProgress,
      modelDownloadPercent: 25,
    },
  ]);
});

describe('prepared graph worker handoff', () => {
  const handoff = {
    version: 1 as const,
    publicationId: 'a'.repeat(32),
    repoPath: '/repo',
    storagePath: '/repo/.gitnexus',
    metadataDirectory: '/repo/.gitnexus',
    repoName: 'repo',
    commit: 'b'.repeat(40),
  };

  it('sends a nonterminal bounded receipt without traversing the graph or finalizing early', async () => {
    const claimTerminal = vi.fn(createTerminalClaim());
    const send = vi.fn();
    const finalize = vi.fn(async () => undefined);
    const run = vi.fn<WorkerAnalysisDeps['runFullAnalysis']>(async () => ({
      ...baseResult,
      preparedGraph: handoff,
      get pipelineResult(): never {
        throw new Error('live graph traversed');
      },
    }));
    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: run,
        assertAnalysisFinalized: finalize,
        claimTerminal,
        isCancelled: () => false,
        send,
      },
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(claimTerminal).not.toHaveBeenCalled();
    expect(claimTerminal()).toBe(true); // A later cancellation still owns one terminal outcome.
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0][0];
    expect(message.type).toBe('graph-prepared');
    expect(message.handoff).toEqual(handoff);
    expect(message.result.preparedGraph).toBeUndefined();
    expect(JSON.stringify(message).length).toBeLessThan(2048);
    expect(run.mock.calls[0][1].skipNativeCloseOnExit).toBe(true);
  });

  it('suppresses a prepared receipt after cancellation', async () => {
    const send = vi.fn();
    const claimTerminal = vi.fn();
    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: vi.fn(async () => ({ ...baseResult, preparedGraph: handoff })),
        assertAnalysisFinalized: okFinalize,
        claimTerminal,
        isCancelled: () => true,
        send,
      },
    );
    expect(send).not.toHaveBeenCalled();
    expect(claimTerminal).not.toHaveBeenCalled();
  });

  it('refuses a collapsed graph before sending its prepared receipt', async () => {
    const send = vi.fn();
    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: vi.fn(async () => ({
          ...baseResult,
          preparedGraph: handoff,
          graphWriteCollapsed: { expected: 100, persisted: 1 },
        })),
        assertAnalysisFinalized: okFinalize,
        claimTerminal: createTerminalClaim(),
        isCancelled: () => false,
        send,
      },
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'error',
      message: 'Collapsed graph cannot be prepared for publication',
    });
  });
});

describe('runWorkerAnalysis — finalize guard (#2264 P2)', () => {
  it('reports error (not complete) when finalization fails for an unregistered repo', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();
    const assertAnalysisFinalized: WorkerAnalysisDeps['assertAnalysisFinalized'] = vi.fn(
      async () => {
        throw new Error('registry entry for /repo was not added');
      },
    );

    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: okRun,
        assertAnalysisFinalized,
        send,
        claimTerminal: alwaysClaim,
      },
    );

    expect(send).toHaveBeenCalledWith({
      type: 'error',
      message: 'registry entry for /repo was not added',
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('reports complete exactly once when finalization succeeds', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();

    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: okRun,
        assertAnalysisFinalized: okFinalize,
        send,
        claimTerminal: alwaysClaim,
      },
    );

    const completes = send.mock.calls.filter((c) => c[0].type === 'complete');
    expect(completes).toHaveLength(1);
    expect(okFinalize).toHaveBeenCalledWith('/repo', '/repo/.gitnexus');
  });

  it('threads the pre-import runner receipt into runFullAnalysis', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();
    const run = vi.fn<WorkerAnalysisDeps['runFullAnalysis']>(async () => baseResult);
    const receipt = { schemaVersion: 4 } as AnalyzerRunnerIdentity;

    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: run,
        assertAnalysisFinalized: okFinalize,
        send,
        claimTerminal: alwaysClaim,
      },
      receipt,
    );

    expect(run.mock.calls[0]?.[3]).toBe(receipt);
  });

  it('reports error when finalization passes but the analysis itself throws', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();
    const failingRun: WorkerAnalysisDeps['runFullAnalysis'] = vi.fn(async () => {
      throw new Error('boom');
    });
    // Fresh local mock (not the shared okFinalize) so the "never called" assertion
    // reflects only this test.
    const finalize = vi.fn<WorkerAnalysisDeps['assertAnalysisFinalized']>(async () => undefined);

    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: failingRun,
        assertAnalysisFinalized: finalize,
        send,
        claimTerminal: alwaysClaim,
      },
    );

    expect(send).toHaveBeenCalledWith({ type: 'error', message: 'boom' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it.each([undefined, '/repo/.gitnexus/analyze.lock.guard'])(
    'classifies lock timeout retryability for guard=%s',
    async (guardPath) => {
      const send = vi.fn<(msg: WorkerMessage) => void>();
      const holder: LockRecord = {
        v: 1,
        pid: -1,
        hostname: 'host',
        startTime: null,
        token: '',
        invocationId: 'unknown',
        acquiredAt: '',
      };
      const lockContended: WorkerAnalysisDeps['runFullAnalysis'] = vi.fn(async () => {
        throw new IndexLockTimeoutError(holder, 600_000, false, guardPath);
      });

      await runWorkerAnalysis(
        '/repo',
        {},
        {
          runFullAnalysis: lockContended,
          assertAnalysisFinalized: okFinalize,
          send,
          claimTerminal: alwaysClaim,
        },
      );

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          code: 'index-lock-timeout',
          retryable: guardPath === undefined,
        }),
      );
      if (guardPath) {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining('quiesced recovery') }),
        );
      }
    },
  );
});

describe('runWorkerAnalysis — terminal-claim coordination (#2264 P3)', () => {
  it('sends NO terminal message when the slot is already claimed (cancellation won)', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();
    const alreadyClaimed: WorkerAnalysisDeps['claimTerminal'] = () => false;

    await runWorkerAnalysis(
      '/repo',
      {},
      {
        runFullAnalysis: okRun,
        assertAnalysisFinalized: okFinalize,
        send,
        claimTerminal: alreadyClaimed,
      },
    );

    const terminals = send.mock.calls.filter(
      (c) => c[0].type === 'complete' || c[0].type === 'error',
    );
    expect(terminals).toHaveLength(0);
  });
});

describe('createTerminalClaim (#2264 P3)', () => {
  it('returns true for the first claim and false for every claim after', () => {
    const claim = createTerminalClaim();
    expect(claim()).toBe(true);
    expect(claim()).toBe(false);
    expect(claim()).toBe(false);
  });

  it('gives independent claims separate slots', () => {
    const a = createTerminalClaim();
    const b = createTerminalClaim();
    expect(a()).toBe(true);
    expect(b()).toBe(true);
    expect(a()).toBe(false);
  });
});
