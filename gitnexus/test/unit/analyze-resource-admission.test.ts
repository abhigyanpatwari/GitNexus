import '../helpers/mock-analysis-host.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';

const runFullAnalysisMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/run-analyze.js', () => ({ runFullAnalysis: runFullAnalysisMock }));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: () => false,
}));
vi.mock('../../src/storage/repo-manager.js', () => ({
  loadMeta: async () => null,
  getStoragePaths: () => ({
    storagePath: '.gitnexus',
    lbugPath: '.gitnexus/lbug',
    metaPath: '.gitnexus/gitnexus.json',
  }),
  getGlobalRegistryPath: () => 'registry.json',
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: async () => undefined,
}));
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: () => '/repo',
  hasGitDir: () => true,
}));

beforeEach(() => {
  vi.resetModules();
  runFullAnalysisMock.mockReset().mockResolvedValue({
    repoName: 'repo',
    repoPath: '/repo',
    stats: {},
    alreadyUpToDate: true,
  });
  process.exitCode = undefined;
  vi.stubEnv('GITNEXUS_MEMORY', 'off');
  for (const key of [
    'GITNEXUS_ANALYSIS_SUPERVISED',
    'GITNEXUS_ANALYSIS_MAIN_HEAP_MB',
    'GITNEXUS_ANALYSIS_SUPERVISOR_BYTES',
    'GITNEXUS_WORKER_POOL_SIZE',
    'GITNEXUS_WORKER_HEAP_MB',
    'GITNEXUS_LBUG_BUFFER_POOL_SIZE',
  ])
    vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('CLI admission with deterministic host inputs', () => {
  it('passes a real bounded allocation to analysis', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { resourceBudget: '8192', workers: '1' });
    expect(process.exitCode).toBeUndefined();
    expect(runFullAnalysisMock).toHaveBeenCalledTimes(1);
    const resources = runFullAnalysisMock.mock.calls[0][1].resources as AnalysisResourceBudget;
    expect(resources.totalBytes).toBe(8192 * 1024 ** 2);
    expect(resources.mainHeapMb).toBe(1024);
    expect(resources.parse.workers).toBe(1);
    expect(resources.parse.reservedBytes).toBeLessThanOrEqual(resources.totalBytes);
  });

  it.each([{ resourceBudget: '512' }, { memoryBudget: '40000' }])(
    'rejects impossible reservations before analysis: %j',
    async (options) => {
      const { _captureLogger } = await import('../../src/core/logger.js');
      const capture = _captureLogger();
      try {
        const { analyzeCommand } = await import('../../src/cli/analyze.js');
        await analyzeCommand(undefined, options);
        expect(process.exitCode).toBe(1);
        expect(runFullAnalysisMock).not.toHaveBeenCalled();
        expect(capture.records().some((record) => record.msg.includes('cannot admit'))).toBe(true);
      } finally {
        capture.restore();
      }
    },
  );
});
