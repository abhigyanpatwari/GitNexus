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

const baseResult: AnalyzeResult = {
  repoName: 'repo',
  repoPath: '/repo',
  stats: {},
  alreadyUpToDate: false,
  ftsRepairedOnly: false,
};

const okRun: WorkerAnalysisDeps['runFullAnalysis'] = vi.fn(async () => baseResult);
const okFinalize: WorkerAnalysisDeps['assertAnalysisFinalized'] = vi.fn(async () => undefined);
const alwaysClaim: WorkerAnalysisDeps['claimTerminal'] = () => true;

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
