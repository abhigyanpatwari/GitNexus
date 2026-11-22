import '../helpers/mock-analysis-host.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runFullAnalysisMock,
  generateAIContextFilesMock,
  generateSkillFilesMock,
  refreshBaseRefLineMock,
  refreshStatsLineMock,
  cliErrorMock,
} = vi.hoisted(() => {
  const runFullAnalysisMock = vi.fn();
  const generateAIContextFilesMock = vi.fn<
    typeof import('../../src/cli/ai-context.js').generateAIContextFiles
  >(async () => ({ files: [] as string[] }));
  const generateSkillFilesMock = vi.fn(async () => ({
    skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
    outputPath: '/repo/.claude/skills',
  }));
  const refreshBaseRefLineMock = vi.fn(async () => ({ files: [] as string[] }));
  const refreshStatsLineMock = vi.fn(
    async (_repoPath: string, _stats: unknown, _options?: { noStats?: boolean }) => ({
      files: [] as string[],
    }),
  );
  const cliErrorMock = vi.fn();
  return {
    runFullAnalysisMock,
    generateAIContextFilesMock,
    generateSkillFilesMock,
    refreshBaseRefLineMock,
    refreshStatsLineMock,
    cliErrorMock,
  };
});

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: generateAIContextFilesMock,
  refreshBaseRefLine: refreshBaseRefLineMock,
  refreshStatsLine: refreshStatsLineMock,
}));

vi.mock('../../src/cli/skill-gen.js', () => ({
  generateSkillFiles: generateSkillFilesMock,
}));

vi.mock('../../src/cli/cli-message.js', () => ({
  cliError: cliErrorMock,
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  loadMeta: vi.fn(async () => null),
  getStoragePaths: vi.fn(() => ({
    storagePath: '.gitnexus',
    lbugPath: '.gitnexus/lbug',
    metaPath: '.gitnexus/gitnexus.json',
  })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
  // #243: default-branch auto-detection. Return null so the resolver falls back
  // to "main" deterministically in this mocked environment.
  getDefaultBranch: vi.fn(() => null),
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
    generateAIContextFilesMock.mockReset();
    generateAIContextFilesMock.mockResolvedValue({ files: [] });
    generateSkillFilesMock.mockReset();
    generateSkillFilesMock.mockResolvedValue({
      skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
      outputPath: '/repo/.claude/skills',
    });
    refreshBaseRefLineMock.mockClear();
    refreshStatsLineMock.mockClear();
    cliErrorMock.mockReset();
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

  it('threads the capture-before-import runner receipt into runFullAnalysis', async () => {
    const { analyzeCommandWithRunnerIdentity } = await import('../../src/cli/analyze.js');
    const receipt = { schemaVersion: 4 } as never;

    await analyzeCommandWithRunnerIdentity(receipt, undefined, {});

    expect(runFullAnalysisMock.mock.calls[0]?.[3]).toBe(receipt);
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

  it('passes --repair-fts through to runFullAnalysis', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairFts: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.repairFts).toBe(true);
  });

  it('maps --no-parse-cache to a cold parser run', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { parseCache: false });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.useParseCache).toBe(false);
    // Not folded into --force: runFullAnalysis names the bypass as its own
    // rebuild reason (#3137), so no run announces a --force nobody passed.
    expect(opts.force).toBeFalsy();
  });

  it('passes --skills through without folding it into --force', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { skills: true });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.skills).toBe(true);
    expect(opts.force).toBeFalsy();
  });

  it('reuses parser output by default', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.useParseCache).toBe(true);
  });

  it('rejects combining --repair-fts with --force', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairFts: true, force: true });

    expect(process.exitCode).toBe(1);
    expect(cliErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/cannot combine `--repair-fts` with a full rebuild/i),
    );
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
  });

  it('rejects combining --repair-fts with --no-parse-cache', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { repairFts: true, parseCache: false });

    expect(process.exitCode).toBe(1);
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
  });

  it.each([{ skills: [] }, { skills: [{ name: 'a', label: 'A', symbolCount: 10, fileCount: 2 }] }])(
    'passes the regenerated inventory and --no-stats to the instruction writer ($skills)',
    async ({ skills }) => {
      generateSkillFilesMock.mockResolvedValueOnce({ skills, outputPath: '/repo/.claude/skills' });
      runFullAnalysisMock.mockResolvedValueOnce({
        repoName: 'repo',
        repoPath: '/repo',
        stats: {
          files: 1,
          nodes: 10,
          edges: 20,
          communities: 0,
          processes: 5,
        },
        alreadyUpToDate: false,
        pipelineResult: { communityResult: undefined },
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      try {
        const { analyzeCommand } = await import('../../src/cli/analyze.js');

        await analyzeCommand(undefined, { skills: true, stats: false });

        expect(generateSkillFilesMock).toHaveBeenCalledTimes(1);
        expect(generateAIContextFilesMock).toHaveBeenCalledTimes(1);
        const call = generateAIContextFilesMock.mock.calls[0];
        expect(call?.[4]).toEqual(skills);
        const aiCtxOpts = call?.[5];
        expect(aiCtxOpts).toEqual({
          refreshCounts: true,
          skipAgentsMd: undefined,
          skipSkills: undefined,
          // #243: resolved default branch threaded into the --skills regen path.
          defaultBranch: 'main',
          noStats: true,
          // #2086 M6: the --pdg gate is threaded too; false here (no --pdg flag).
          hasPdg: false,
          hasSpringActuator: false,
        });
      } finally {
        exitSpy.mockRestore();
      }
    },
  );

  it('applies --no-stats to an already up-to-date index (#3618)', async () => {
    // The fast path returns before generateAIContextFiles, so the flag only
    // takes effect through the in-place stats refresh — otherwise it stays a
    // no-op on every repo that was already indexed.
    const stats = { nodes: 10, edges: 20, processes: 3 };
    runFullAnalysisMock.mockResolvedValueOnce({
      repoName: 'repo',
      repoPath: '/repo',
      stats,
      alreadyUpToDate: true,
    });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: false });

    expect(refreshStatsLineMock).toHaveBeenCalledTimes(1);
    expect(refreshStatsLineMock).toHaveBeenCalledWith('/repo', stats, {
      refreshCounts: true,
      noStats: true,
      skipAgentsMd: undefined,
    });
  });

  it('restores stats by default on an already up-to-date index', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(refreshStatsLineMock).toHaveBeenCalledWith(
      '/repo',
      {},
      {
        refreshCounts: true,
        noStats: false,
        skipAgentsMd: undefined,
      },
    );
  });

  it.each([{ skipAgentsMd: true }, { indexOnly: true }])(
    'forwards context suppression to the fast-path refresh with %j',
    async (options) => {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { ...options, stats: false });

      expect(refreshStatsLineMock).toHaveBeenCalledWith(
        '/repo',
        {},
        {
          refreshCounts: true,
          noStats: true,
          skipAgentsMd: true,
        },
      );
    },
  );

  it('does not refresh root context files for an up-to-date pinned branch index', async () => {
    runFullAnalysisMock.mockResolvedValueOnce({
      repoName: 'repo',
      repoPath: '/repo',
      stats: { nodes: 10, edges: 20, processes: 3 },
      alreadyUpToDate: true,
      isPrimaryBranch: false,
    });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { stats: false });

    expect(refreshStatsLineMock).not.toHaveBeenCalled();
    expect(refreshBaseRefLineMock).not.toHaveBeenCalled();
  });
});
