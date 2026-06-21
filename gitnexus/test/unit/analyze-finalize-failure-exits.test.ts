/**
 * Regression test for the #2264 review P1: when a full analyze succeeds (which
 * skip-closes LadybugDB, leaving native handles open) and a post-finalize step
 * THEN throws, the CLI's outer catch soft-returns (`process.exitCode = 1`). With
 * native handles open, the event loop can't drain — the process would HANG. The
 * `analyzeCommand` wrapper now force-exits when `isLbugReady()` is true after the
 * soft return. This test drives that exact path and asserts termination.
 *
 * Test-safety: when `isLbugReady()` is false (the default in every analyze unit
 * test that mocks run-analyze — the DB is never opened), the wrapper must NOT
 * force-exit, preserving the soft return those tests rely on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runFullAnalysisMock,
  assertAnalysisFinalizedMock,
  isLbugReadyMock,
  AnalysisNotFinalizedError,
} = vi.hoisted(() => {
  class AnalysisNotFinalizedError extends Error {
    storagePath = '.gitnexus';
  }
  return {
    runFullAnalysisMock: vi.fn(),
    assertAnalysisFinalizedMock: vi.fn(),
    isLbugReadyMock: vi.fn(() => false),
    AnalysisNotFinalizedError,
  };
});

vi.mock('../../src/core/run-analyze.js', () => ({ runFullAnalysis: runFullAnalysisMock }));
vi.mock('../../src/cli/ai-context.js', () => ({
  generateAIContextFiles: vi.fn(async () => ({ files: [] as string[] })),
  refreshBaseRefLine: vi.fn(async () => ({ files: [] as string[] })),
}));
vi.mock('../../src/cli/skill-gen.js', () => ({ generateSkillFiles: vi.fn() }));
vi.mock('../../src/cli/cli-message.js', () => ({ cliError: vi.fn() }));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  isLbugReady: isLbugReadyMock,
}));
vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({ storagePath: '.gitnexus', lbugPath: '.gitnexus/lbug' })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError,
  assertAnalysisFinalized: assertAnalysisFinalizedMock,
}));
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
  getDefaultBranch: vi.fn(() => null),
}));
vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

describe('analyzeCommand — finalize-failure must terminate, not hang (#2264 P1)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    // Full analysis succeeded (NOT the alreadyUpToDate fast path) → skip-closed.
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: false,
      ftsRepairedOnly: false,
      pipelineResult: { communityResult: undefined },
    });
    assertAnalysisFinalizedMock.mockReset();
    // Post-finalize check throws (the documented silent-finalize state).
    assertAnalysisFinalizedMock.mockRejectedValue(new AnalysisNotFinalizedError('not finalized'));
    isLbugReadyMock.mockReset();
    process.exitCode = undefined;
  });

  it('force-exits when native handles are still open (isLbugReady true)', async () => {
    isLbugReadyMock.mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      await analyzeCommand(undefined, {});
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('does NOT force-exit when no handles are open (isLbugReady false) — soft return preserved', async () => {
    isLbugReadyMock.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      await analyzeCommand(undefined, {});
      expect(exitSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
