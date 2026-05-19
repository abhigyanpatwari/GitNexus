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

describe('analyzeCommand --workers validation', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
    delete process.env.GITNEXUS_WORKER_POOL_SIZE;
  });

  it.each(['abc', '-5', '1.5', 'Infinity', 'NaN'])(
    'rejects invalid --workers value %s before analysis starts',
    async (workers) => {
      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { workers });

      expect(process.exitCode).toBe(1);
      expect(
        cap
          .records()
          .some((r) =>
            String(r.msg ?? '').startsWith('  --workers must be a non-negative integer'),
          ),
      ).toBe(true);
      expect(runFullAnalysisMock).not.toHaveBeenCalled();
      cap.restore();
    },
  );

  it('sets GITNEXUS_WORKER_POOL_SIZE for valid positive values', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    await analyzeCommand(undefined, { workers: '12' });

    expect(process.env.GITNEXUS_WORKER_POOL_SIZE).toBe('12');
    expect(runFullAnalysisMock).toHaveBeenCalled();
  });

  it('accepts --workers 0 as a sequential-fallback signal', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    await analyzeCommand(undefined, { workers: '0' });

    expect(process.env.GITNEXUS_WORKER_POOL_SIZE).toBe('0');
    expect(process.exitCode).toBeUndefined();
    expect(runFullAnalysisMock).toHaveBeenCalled();
  });
});
