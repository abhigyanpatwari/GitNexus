import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runFullAnalysisMock, generateAIContextFilesMock, generateSkillFilesMock } = vi.hoisted(
  () => {
    const runFullAnalysisMock = vi.fn();
    const generateAIContextFilesMock = vi.fn(async () => ({ files: [] as string[] }));
    const generateSkillFilesMock = vi.fn(async () => ({
      skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
      outputPath: '/repo/.claude/skills/generated',
    }));
    return { runFullAnalysisMock, generateAIContextFilesMock, generateSkillFilesMock };
  },
);

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: generateAIContextFilesMock,
}));

vi.mock('../../src/cli/skill-gen.js', () => ({
  generateSkillFiles: generateSkillFilesMock,
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
    generateAIContextFilesMock.mockReset();
    generateAIContextFilesMock.mockResolvedValue({ files: [] });
    generateSkillFilesMock.mockReset();
    generateSkillFilesMock.mockResolvedValue({
      skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
      outputPath: '/repo/.claude/skills/generated',
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

  it('passes stats:false as noStats to generateAIContextFiles on the --skills regeneration path (#1477)', async () => {
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
      const aiCtxOpts = generateAIContextFilesMock.mock.calls[0]![5];
      expect(aiCtxOpts).toEqual({
        skipAgentsMd: undefined,
        skipSkills: undefined,
        noStats: true,
      });
    } finally {
      exitSpy.mockRestore();
    }
  });
});
