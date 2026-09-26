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

describe('analyzeCommand --memory-budget (#3137)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it.each(['abc', '-5', '1.5', 'Infinity', 'NaN', '0', '199'])(
    'rejects invalid --memory-budget value %s before analysis starts',
    async (memoryBudget) => {
      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { memoryBudget });

      expect(process.exitCode).toBe(1);
      expect(
        cap
          .records()
          .some((r) => String(r.msg ?? '').startsWith('  --memory-budget must be an integer >= 200')),
      ).toBe(true);
      expect(runFullAnalysisMock).not.toHaveBeenCalled();
      cap.restore();
    },
  );

  it('threads --memory-budget through runFullAnalysis options as byte-scaled memoryBudgetBytes', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    await analyzeCommand(undefined, { memoryBudget: '4096' });

    expect(runFullAnalysisMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ memoryBudgetBytes: 4096 * 1024 * 1024 }),
      expect.any(Object),
    );
  });

  it('omitting --memory-budget leaves memoryBudgetBytes undefined (auto-sizer path)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });

    await analyzeCommand(undefined, {});

    expect(runFullAnalysisMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ memoryBudgetBytes: undefined }),
      expect.any(Object),
    );
  });
});

describe('parse-impl heap-limit resolution under --memory-budget (#3137)', () => {
  // projectParseHeapNeedBytes = files × 75 nodes × 1600 B/node — the shipped
  // projection from #2649. These tests pin the budget's two observable
  // effects: the preflight warning threshold and the abort probe ceiling.
  // The vitest config ships GITNEXUS_MEMORY=off globally (respawn tests
  // delete it in their own setups); the abort probe under test is the
  // autopilot's enforcement arm, so re-enable it here.
  const ORIGINAL_MEMORY = process.env.GITNEXUS_MEMORY;

  beforeEach(() => {
    process.env.GITNEXUS_MEMORY = 'on';
  });

  afterEach(() => {
    if (ORIGINAL_MEMORY === undefined) {
      delete process.env.GITNEXUS_MEMORY;
    } else {
      process.env.GITNEXUS_MEMORY = ORIGINAL_MEMORY;
    }
  });

  it('projects heap need at the documented per-file rate', async () => {
    const { projectParseHeapNeedBytes } = await import(
      '../../src/core/ingestion/pipeline-phases/parse-impl.js'
    );
    // 1000 files → 75k nodes → 120 MB projected.
    expect(projectParseHeapNeedBytes(1000)).toBe(1000 * 75 * 1600);
  });

  it('abort probe honors the 0.92 fraction against the passed limit', async () => {
    const { shouldAbortForHeapPressure } = await import(
      '../../src/core/ingestion/pipeline-phases/parse-impl.js'
    );
    const budget = 200 * 1024 * 1024;
    expect(shouldAbortForHeapPressure(budget * 0.91, budget)).toBe(false);
    expect(shouldAbortForHeapPressure(budget * 0.93, budget)).toBe(true);
  });
});
