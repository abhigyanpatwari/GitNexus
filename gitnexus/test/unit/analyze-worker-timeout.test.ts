import { beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({ storagePath: '.gitnexus', lbugPath: '.gitnexus/lbug' })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
}));

vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

describe('analyzeCommand worker timeout validation', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
    delete process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS;
  });

  it.each(['0', 'abc', '-5', 'Infinity'])(
    'rejects invalid --worker-timeout value %s before analysis starts',
    async (workerTimeout) => {
      // Import _captureLogger from the SAME module instance analyze.js will
      // see — vi.resetModules() in beforeEach invalidates the singleton.
      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { workerTimeout });

      expect(process.exitCode).toBe(1);
      expect(
        cap.records().some((r) => r.msg === '  --worker-timeout must be at least 1 second.\n'),
      ).toBe(true);
      expect(runFullAnalysisMock).not.toHaveBeenCalled();
      cap.restore();
    },
  );

  it('sets the worker timeout environment variable for valid values', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    await analyzeCommand(undefined, { workerTimeout: '2' });

    expect(process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS).toBe('2000');
    expect(runFullAnalysisMock).toHaveBeenCalled();
  });
});
