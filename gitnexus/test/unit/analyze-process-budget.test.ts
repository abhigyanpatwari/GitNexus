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

describe('analyzeCommand process-detection budget (#3313)', () => {
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
    vi.unstubAllEnvs();
  });

  const upToDate = {
    repoName: 'repo',
    repoPath: '/repo',
    stats: {},
    alreadyUpToDate: true,
  };

  it('threads the four CLI flags through runFullAnalysis without env mutation', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue(upToDate);
    const before = {
      processes: process.env.GITNEXUS_MAX_PROCESSES,
      branching: process.env.GITNEXUS_MAX_PROCESS_BRANCHING,
      depth: process.env.GITNEXUS_MAX_PROCESS_TRACE_DEPTH,
      entries: process.env.GITNEXUS_MAX_ENTRY_POINT_CANDIDATES,
    };

    await analyzeCommand(undefined, {
      maxProcesses: '25',
      maxProcessBranching: '2',
      maxProcessTraceDepth: '8',
      maxEntryPointCandidates: '400',
    });

    expect(runFullAnalysisMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maxProcesses: 25,
        maxProcessBranching: 2,
        maxProcessTraceDepth: 8,
        maxEntryPointCandidates: 400,
      }),
      expect.any(Object),
    );
    expect(process.env.GITNEXUS_MAX_PROCESSES).toBe(before.processes);
    expect(process.env.GITNEXUS_MAX_PROCESS_BRANCHING).toBe(before.branching);
    expect(process.env.GITNEXUS_MAX_PROCESS_TRACE_DEPTH).toBe(before.depth);
    expect(process.env.GITNEXUS_MAX_ENTRY_POINT_CANDIDATES).toBe(before.entries);
  });

  it.each(['0', 'abc', '-4'])(
    'warns and continues when --max-processes is %s (AE5)',
    async (value) => {
      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      try {
        const { analyzeCommand } = await import('../../src/cli/analyze.js');
        runFullAnalysisMock.mockResolvedValue(upToDate);

        await analyzeCommand(undefined, { maxProcesses: value });

        expect(process.exitCode).toBeUndefined();
        expect(runFullAnalysisMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.not.objectContaining({ maxProcesses: expect.any(Number) }),
          expect.any(Object),
        );
        expect(
          cap.records().some((r) => {
            const msg = String(r.msg ?? '');
            return (
              msg.includes('--max-processes must be a positive integer') &&
              msg.includes('next source (env, then the built-in default)')
            );
          }),
        ).toBe(true);
      } finally {
        cap.restore();
      }
    },
  );

  it('leaves option fields unset so runFullAnalysis can honor env-only overrides', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    runFullAnalysisMock.mockResolvedValue(upToDate);
    vi.stubEnv('GITNEXUS_MAX_PROCESSES', '80');

    await analyzeCommand(undefined, {});

    const opts = runFullAnalysisMock.mock.calls[0][1] as { maxProcesses?: number };
    expect(opts.maxProcesses).toBeUndefined();
  });
});
