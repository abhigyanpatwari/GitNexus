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

describe('analyzeCommand --embeddings [limit] parsing', () => {
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

  it.each(['abc', '-1', '1.5', 'NaN', 'Infinity'])(
    'rejects invalid --embeddings value %s before analysis starts',
    async (embeddings) => {
      // The validator routes through cli-message (`cliError`), which
      // writes plain text directly to process.stderr. Spy on the raw
      // stderr handle rather than `console.error`, since the migration
      // bypasses console entirely.
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { embeddings });

      expect(process.exitCode).toBe(1);
      expect(runFullAnalysisMock).not.toHaveBeenCalled();
      const allWrites = stderrSpy.mock.calls
        .map(([chunk]) => (typeof chunk === 'string' ? chunk : chunk.toString()))
        .join('');
      expect(allWrites).toContain('--embeddings expects a non-negative integer');
      expect(allWrites).toContain(`got "${embeddings}"`);
      stderrSpy.mockRestore();
    },
  );

  it('bare --embeddings forwards undefined limit (default cap honored downstream)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(runFullAnalysisMock).toHaveBeenCalledTimes(1);
    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.embeddings).toBe(true);
    expect(opts.embeddingsNodeLimit).toBeUndefined();
  });

  it('--embeddings 0 forwards 0 (cap disabled downstream)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: '0' });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.embeddings).toBe(true);
    expect(opts.embeddingsNodeLimit).toBe(0);
  });

  it('--embeddings <n> forwards a positive custom cap', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: '100000' });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.embeddings).toBe(true);
    expect(opts.embeddingsNodeLimit).toBe(100_000);
  });

  it('omitted --embeddings keeps embeddings off (boolean false, no limit)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.embeddings).toBe(false);
    expect(opts.embeddingsNodeLimit).toBeUndefined();
  });
});
