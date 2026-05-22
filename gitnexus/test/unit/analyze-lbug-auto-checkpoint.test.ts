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

describe('analyzeCommand --lbug-auto-checkpoint parsing', () => {
  const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;
  const ORIGINAL_AUTO_CHECKPOINT = process.env.GITNEXUS_LBUG_AUTO_CHECKPOINT;

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
    if (ORIGINAL_AUTO_CHECKPOINT === undefined) {
      delete process.env.GITNEXUS_LBUG_AUTO_CHECKPOINT;
    } else {
      process.env.GITNEXUS_LBUG_AUTO_CHECKPOINT = ORIGINAL_AUTO_CHECKPOINT;
    }
  });

  it.each(['maybe', '2', '', 'enabled'])(
    'rejects invalid --lbug-auto-checkpoint value %s before analysis starts',
    async (lbugAutoCheckpoint) => {
      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { lbugAutoCheckpoint });

      expect(process.exitCode).toBe(1);
      expect(runFullAnalysisMock).not.toHaveBeenCalled();
      expect(
        cap
          .records()
          .some((r) => r.msg === '  --lbug-auto-checkpoint must be either "on" or "off".\n'),
      ).toBe(true);
      cap.restore();
    },
  );

  it.each([
    ['on', 'true'],
    ['off', 'false'],
    ['1', 'true'],
    ['0', 'false'],
  ])(
    'sets GITNEXUS_LBUG_AUTO_CHECKPOINT=%s to %s during runFullAnalysis and restores afterwards',
    async (cliValue, expectedEnv) => {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      let envAtCallTime: string | undefined;
      runFullAnalysisMock.mockImplementation(async () => {
        envAtCallTime = process.env.GITNEXUS_LBUG_AUTO_CHECKPOINT;
        return {
          repoName: 'repo',
          repoPath: '/repo',
          stats: {},
          alreadyUpToDate: true,
        };
      });

      await analyzeCommand(undefined, { lbugAutoCheckpoint: cliValue });

      expect(envAtCallTime).toBe(expectedEnv);
      expect(process.env.GITNEXUS_LBUG_AUTO_CHECKPOINT).toBe(ORIGINAL_AUTO_CHECKPOINT);
    },
  );
});
