import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // Capture the host's NODE_OPTIONS once so afterEach can restore it cleanly,
  // and the env-leak regression test below has a stable baseline. Without
  // afterEach, beforeEach's `process.env.NODE_OPTIONS = ...` accumulated
  // `--max-old-space-size=8192` tokens across runs (L4 from PR #1693 review).
  const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;

  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  afterEach(() => {
    if (ORIGINAL_NODE_OPTIONS === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = ORIGINAL_NODE_OPTIONS;
    }
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

  it('threads --workers through runFullAnalysis options as workerPoolSize', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    await analyzeCommand(undefined, { workers: '12' });

    expect(runFullAnalysisMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workerPoolSize: 12 }),
      expect.any(Object),
    );
  });

  it('threads --workers 0 as workerPoolSize: 0 (sequential-fallback signal)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    await analyzeCommand(undefined, { workers: '0' });

    expect(runFullAnalysisMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workerPoolSize: 0 }),
      expect.any(Object),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('does not mutate GITNEXUS_WORKER_POOL_SIZE in process.env', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    const before = process.env.GITNEXUS_WORKER_POOL_SIZE;
    await analyzeCommand(undefined, { workers: '7' });
    expect(process.env.GITNEXUS_WORKER_POOL_SIZE).toBe(before);
  });

  it('restores snapshotted env vars after returning (no cross-invocation leak)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    const originalVerbose = process.env.GITNEXUS_VERBOSE;
    const originalMaxFileSize = process.env.GITNEXUS_MAX_FILE_SIZE;
    await analyzeCommand(undefined, { verbose: true, maxFileSize: '1024' });
    expect(process.env.GITNEXUS_VERBOSE).toBe(originalVerbose);
    expect(process.env.GITNEXUS_MAX_FILE_SIZE).toBe(originalMaxFileSize);
  });
});
