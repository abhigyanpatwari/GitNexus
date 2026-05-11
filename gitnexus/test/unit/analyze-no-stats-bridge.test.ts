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

describe('analyzeCommand commander → runFullAnalysis noStats bridge (#1477)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('maps commander-shaped stats:false to noStats:true (equivalent to --no-stats)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: false });

    expect(runFullAnalysisMock).toHaveBeenCalledTimes(1);
    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(true);
  });

  it('maps omitted stats to noStats:false (default-on preserved)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(false);
  });

  it('maps explicit stats:true to noStats:false', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(false);
  });

  it('still maps stats:false to noStats:true when skipAgentsMd is set', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: false, skipAgentsMd: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(true);
    expect(opts.skipAgentsMd).toBe(true);
  });
});
