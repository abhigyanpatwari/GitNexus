import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * End-to-end wiring tests for project-local `.gitnexusrc` (#243).
 *
 * Unlike analyze-config.test.ts (which unit-tests the pure config module), these
 * drive the REAL `analyzeCommand` with a REAL `.gitnexusrc` on disk and a real
 * `analyze-config` module — only the heavy pipeline (`runFullAnalysis`,
 * `generateAIContextFiles`, skill-gen, LadybugDB) and git are mocked. They fail
 * if config is parsed but not threaded into the analyze/context path.
 */

const {
  runFullAnalysisMock,
  generateAIContextFilesMock,
  refreshBaseRefLineMock,
  generateSkillFilesMock,
  cliErrorMock,
  getDefaultBranchMock,
} = vi.hoisted(() => ({
  runFullAnalysisMock: vi.fn(),
  generateAIContextFilesMock: vi.fn(async () => ({ files: [] as string[] })),
  refreshBaseRefLineMock: vi.fn(async () => ({ files: [] as string[] })),
  generateSkillFilesMock: vi.fn(async () => ({
    skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
    outputPath: '/repo/.claude/skills/generated',
  })),
  cliErrorMock: vi.fn(),
  getDefaultBranchMock: vi.fn<(p: string) => string | null>(() => null),
}));

vi.mock('../../src/core/run-analyze.js', () => ({ runFullAnalysis: runFullAnalysisMock }));
vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: generateAIContextFilesMock,
  refreshBaseRefLine: refreshBaseRefLineMock,
}));
vi.mock('../../src/cli/skill-gen.js', () => ({ generateSkillFiles: generateSkillFilesMock }));
vi.mock('../../src/cli/cli-message.js', () => ({ cliError: cliErrorMock }));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn((repoPath: string) => ({
    storagePath: path.join(repoPath, '.gitnexus'),
    lbugPath: path.join(repoPath, '.gitnexus', 'lbug'),
  })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));

// hasGitDir true; getGitRoot is unused because tests pass an explicit path.
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn((p: string) => p),
  hasGitDir: vi.fn(() => true),
  getDefaultBranch: getDefaultBranchMock,
}));

vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

const upToDate = {
  repoName: 'repo',
  repoPath: '/repo',
  stats: {},
  alreadyUpToDate: true,
};

describe('analyzeCommand .gitnexusrc wiring (#243)', () => {
  let dir: string;

  beforeEach(async () => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    runFullAnalysisMock.mockResolvedValue(upToDate);
    generateAIContextFilesMock.mockReset();
    generateAIContextFilesMock.mockResolvedValue({ files: [] });
    refreshBaseRefLineMock.mockReset();
    refreshBaseRefLineMock.mockResolvedValue({ files: [] });
    generateSkillFilesMock.mockReset();
    generateSkillFilesMock.mockResolvedValue({
      skills: [{ name: 'c', label: 'Community', symbolCount: 1, fileCount: 1 }],
      outputPath: '/repo/.claude/skills/generated',
    });
    cliErrorMock.mockReset();
    getDefaultBranchMock.mockReset();
    getDefaultBranchMock.mockReturnValue(null);
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-rc-wire-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeRc = (obj: unknown) =>
    fs.writeFile(path.join(dir, '.gitnexusrc'), JSON.stringify(obj));

  it('maps .gitnexusrc skipContextFiles to skipAgentsMd without implying skipSkills', async () => {
    await writeRc({ skipContextFiles: true });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, {});

    expect(runFullAnalysisMock).toHaveBeenCalledTimes(1);
    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.skipAgentsMd).toBe(true);
    expect(opts.skipSkills).toBeFalsy();
  });

  it('indexOnly from config remains stronger than context/skills options', async () => {
    await writeRc({ indexOnly: true });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, {});

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.skipAgentsMd).toBe(true);
    expect(opts.skipSkills).toBe(true);
  });

  it('uses .gitnexusrc defaultBranch for generated context', async () => {
    await writeRc({ defaultBranch: 'develop' });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, {});

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.defaultBranch).toBe('develop');
    // A configured branch must short-circuit auto-detection.
    expect(getDefaultBranchMock).not.toHaveBeenCalled();
  });

  it('lets --default-branch override .gitnexusrc defaultBranch', async () => {
    await writeRc({ defaultBranch: 'develop' });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, { defaultBranch: 'cli-branch' });

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(opts.defaultBranch).toBe('cli-branch');
  });

  it('auto-detects the default branch when neither CLI nor config set it', async () => {
    // No .gitnexusrc on disk.
    getDefaultBranchMock.mockReturnValue('trunk');
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, {});

    const opts = runFullAnalysisMock.mock.calls[0][1];
    expect(getDefaultBranchMock).toHaveBeenCalledTimes(1);
    expect(opts.defaultBranch).toBe('trunk');
  });

  it('fails before analysis on an invalid .gitnexusrc, with an actionable error', async () => {
    await fs.writeFile(path.join(dir, '.gitnexusrc'), '{ broken json ');
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, {});

    expect(process.exitCode).toBe(1);
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
    expect(cliErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.gitnexusrc/),
      expect.objectContaining({ recoveryHint: 'gitnexusrc-invalid' }),
    );
  });

  it('threads the resolved branch into the --skills re-generation (does not revert to main)', async () => {
    await writeRc({ defaultBranch: 'develop' });
    runFullAnalysisMock.mockResolvedValueOnce({
      repoName: 'repo',
      repoPath: dir,
      stats: { files: 1, nodes: 10, edges: 20, communities: 0, processes: 5 },
      alreadyUpToDate: false,
      pipelineResult: { communityResult: undefined },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(dir, { skills: true });

      expect(generateSkillFilesMock).toHaveBeenCalledTimes(1);
      expect(generateAIContextFilesMock).toHaveBeenCalledTimes(1);
      const aiCtxOpts = generateAIContextFilesMock.mock.calls[0]![5];
      expect(aiCtxOpts).toMatchObject({ defaultBranch: 'develop' });
    } finally {
      exitSpy.mockRestore();
    }
  });

  // ── #1996 tri-review hardening ─────────────────────────────────────

  it('rejects an invalid --default-branch up front with a CLI-specific hint (#1996)', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, { defaultBranch: 'bad branch' });

    expect(process.exitCode).toBe(1);
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
    expect(cliErrorMock).toHaveBeenCalledWith(
      expect.stringMatching(/--default-branch/),
      expect.objectContaining({ recoveryHint: 'default-branch-invalid' }),
    );
  });

  it('does not auto-detect the branch when config skips context generation (#1996)', async () => {
    await writeRc({ skipAgentsMd: true });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, {});

    // willGenerateContext=false ⇒ no git call for the (unused) branch.
    expect(getDefaultBranchMock).not.toHaveBeenCalled();
    expect(runFullAnalysisMock.mock.calls[0][1].skipAgentsMd).toBe(true);
  });

  it('refreshes base_ref in place on the alreadyUpToDate fast path (#1996 P2)', async () => {
    await writeRc({ defaultBranch: 'develop' });
    // Default mock returns alreadyUpToDate:true.
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(dir, {});

    expect(refreshBaseRefLineMock).toHaveBeenCalledTimes(1);
    expect(refreshBaseRefLineMock).toHaveBeenCalledWith(dir, 'develop', expect.any(Object));
  });
});
