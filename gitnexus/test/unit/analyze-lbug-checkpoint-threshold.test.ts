import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
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

describe('analyzeCommand --wal-checkpoint-threshold parsing', () => {
  const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;
  const ORIGINAL_THRESHOLD = process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD;

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
    if (ORIGINAL_THRESHOLD === undefined) {
      delete process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD;
    } else {
      process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD = ORIGINAL_THRESHOLD;
    }
  });

  it.each(['maybe', '-2', '1.5', ''])(
    'rejects invalid --wal-checkpoint-threshold value %s before analysis starts',
    async (walCheckpointThreshold) => {
      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { walCheckpointThreshold });

      expect(process.exitCode).toBe(1);
      expect(runFullAnalysisMock).not.toHaveBeenCalled();
      expect(
        cap
          .records()
          .some((r) => r.msg === '  --wal-checkpoint-threshold must be an integer >= -1.\n'),
      ).toBe(true);
      cap.restore();
    },
  );

  it.each([
    ['-1', '-1'],
    ['0', '0'],
    ['1024', '1024'],
  ])(
    'sets GITNEXUS_WAL_CHECKPOINT_THRESHOLD=%s during runFullAnalysis and restores afterwards',
    async (cliValue, expectedEnv) => {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      let envAtCallTime: string | undefined;
      runFullAnalysisMock.mockImplementation(async () => {
        envAtCallTime = process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD;
        return {
          repoName: 'repo',
          repoPath: '/repo',
          stats: {},
          alreadyUpToDate: true,
        };
      });

      await analyzeCommand(undefined, { walCheckpointThreshold: cliValue });

      expect(envAtCallTime).toBe(expectedEnv);
      expect(process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD).toBe(ORIGINAL_THRESHOLD);
    },
  );
});
