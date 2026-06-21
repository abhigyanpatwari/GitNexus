/**
 * Unit tests for the analyze-worker core seam (#2264 P2). The worker must NOT
 * report `complete` for a half-finalized repo (meta.json written but the global
 * registry entry missing) — it must surface that as an error, mirroring the CLI's
 * assertAnalysisFinalized guard. Driven via the side-effect-free
 * `runWorkerAnalysis` seam with injected fakes, so no fork()/process.on side
 * effects of the entry module are touched.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runWorkerAnalysis,
  type WorkerAnalysisDeps,
} from '../../src/server/analyze-worker-core.js';
import type { AnalyzeResult } from '../../src/core/run-analyze.js';
import type { WorkerMessage } from '../../src/server/analyze-worker.js';

describe('runWorkerAnalysis — worker finalize guard (#2264 P2)', () => {
  const baseResult: AnalyzeResult = {
    repoName: 'repo',
    repoPath: '/repo',
    stats: {},
    alreadyUpToDate: false,
    ftsRepairedOnly: false,
  };

  const okRun: WorkerAnalysisDeps['runFullAnalysis'] = vi.fn(async () => baseResult);

  it('reports error (not complete) when finalization fails for an unregistered repo', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();
    const assertAnalysisFinalized: WorkerAnalysisDeps['assertAnalysisFinalized'] = vi.fn(
      async () => {
        throw new Error('registry entry for /repo was not added');
      },
    );

    await runWorkerAnalysis('/repo', {}, { runFullAnalysis: okRun, assertAnalysisFinalized, send });

    expect(send).toHaveBeenCalledWith({
      type: 'error',
      message: 'registry entry for /repo was not added',
    });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'complete' }));
  });

  it('reports complete exactly once when finalization succeeds', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();
    const assertAnalysisFinalized: WorkerAnalysisDeps['assertAnalysisFinalized'] = vi.fn(
      async () => undefined,
    );

    await runWorkerAnalysis('/repo', {}, { runFullAnalysis: okRun, assertAnalysisFinalized, send });

    const completes = send.mock.calls.filter((c) => c[0].type === 'complete');
    expect(completes).toHaveLength(1);
  });

  it('reports error when finalization passes but the analysis itself throws', async () => {
    const send = vi.fn<(msg: WorkerMessage) => void>();
    const failingRun: WorkerAnalysisDeps['runFullAnalysis'] = vi.fn(async () => {
      throw new Error('boom');
    });
    const assertAnalysisFinalized: WorkerAnalysisDeps['assertAnalysisFinalized'] = vi.fn(
      async () => undefined,
    );

    await runWorkerAnalysis(
      '/repo',
      {},
      { runFullAnalysis: failingRun, assertAnalysisFinalized, send },
    );

    expect(send).toHaveBeenCalledWith({ type: 'error', message: 'boom' });
    expect(assertAnalysisFinalized).not.toHaveBeenCalled();
  });
});
