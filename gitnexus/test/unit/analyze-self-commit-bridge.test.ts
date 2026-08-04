import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runFullAnalysisMock,
  generateAIContextFilesMock,
  generateSkillFilesMock,
  cliErrorMock,
  selfCommitContextFilesMock,
  snapshotSelfCommitSafetyMock,
} = vi.hoisted(() => {
  const runFullAnalysisMock = vi.fn();
  const generateAIContextFilesMock = vi.fn(async () => ({ files: [] as string[] }));
  const generateSkillFilesMock = vi.fn(async () => ({
    skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
    outputPath: '/repo/.claude/skills',
  }));
  const cliErrorMock = vi.fn();
  const selfCommitContextFilesMock = vi.fn();
  const snapshotSelfCommitSafetyMock = vi.fn(
    () =>
      new Map([
        ['AGENTS.md', true],
        ['CLAUDE.md', true],
      ]),
  );
  return {
    runFullAnalysisMock,
    generateAIContextFilesMock,
    generateSkillFilesMock,
    cliErrorMock,
    selfCommitContextFilesMock,
    snapshotSelfCommitSafetyMock,
  };
});

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: generateAIContextFilesMock,
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
  getStoragePaths: vi.fn(() => ({ storagePath: '.gitnexus', lbugPath: '.gitnexus/lbug' })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
  getDefaultBranch: vi.fn(() => null),
  selfCommitContextFiles: selfCommitContextFilesMock,
  snapshotSelfCommitSafety: snapshotSelfCommitSafetyMock,
}));

vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

describe('analyzeCommand --self-commit bridge (#2639)', () => {
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
    cliErrorMock.mockReset();
    selfCommitContextFilesMock.mockReset();
    snapshotSelfCommitSafetyMock.mockClear();
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('does not call selfCommitContextFiles when --self-commit is omitted (default off)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(selfCommitContextFilesMock).not.toHaveBeenCalled();
  });

  it('does not call selfCommitContextFiles when --self-commit is explicitly false', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { selfCommit: false });

    expect(selfCommitContextFilesMock).not.toHaveBeenCalled();
  });

  it('calls selfCommitContextFiles scoped to AGENTS.md/CLAUDE.md on the already-up-to-date fast path', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { selfCommit: true });

    expect(selfCommitContextFilesMock).toHaveBeenCalledTimes(1);
    expect(selfCommitContextFilesMock).toHaveBeenCalledWith(
      '/repo',
      ['AGENTS.md', 'CLAUDE.md'],
      expect.any(Map),
    );
  });

  it('calls selfCommitContextFiles on the primary (non-fast-path) analyze run', async () => {
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

      await analyzeCommand(undefined, { selfCommit: true });

      expect(selfCommitContextFilesMock).toHaveBeenCalledTimes(1);
      expect(selfCommitContextFilesMock).toHaveBeenCalledWith(
        '/repo',
        ['AGENTS.md', 'CLAUDE.md'],
        expect.any(Map),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('does not call selfCommitContextFiles on the primary run when --self-commit is omitted', async () => {
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

      await analyzeCommand(undefined, {});

      expect(selfCommitContextFilesMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('composes with --no-stats (both flags threaded independently)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { selfCommit: true, stats: false });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.noStats).toBe(true);
    expect(selfCommitContextFilesMock).toHaveBeenCalledWith(
      '/repo',
      ['AGENTS.md', 'CLAUDE.md'],
      expect.any(Map),
    );
  });
});
