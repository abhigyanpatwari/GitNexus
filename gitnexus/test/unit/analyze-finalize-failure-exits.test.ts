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
 *
 * Worker-safety: `analyzeCommand` calls `installFatalHandlers()`, which registers
 * global `unhandledRejection` / `uncaughtException` handlers that call the REAL
 * `process.exit(1)`. Across this file's `vi.resetModules()` reimports those
 * accumulate on `process`, and a stray async rejection firing one while no
 * `process.exit` spy is active would kill the forked vitest worker ("Worker
 * exited unexpectedly"). So we keep `process.exit` spied for the WHOLE file and
 * strip the handlers `installFatalHandlers` added in `afterAll`, and reset
 * `process.exitCode` so the worker exits clean.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

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
  // Snapshot the fatal-handler listeners present BEFORE this file ran (vitest's
  // own) so afterAll can strip only the ones installFatalHandlers added, leaving
  // vitest's intact for the rest of the worker's life.
  const baselineUnhandled = process.listeners('unhandledRejection');
  const baselineUncaught = process.listeners('uncaughtException');
  let exitSpy: MockInstance<typeof process.exit>;

  beforeAll(() => {
    // Mock process.exit for the WHOLE file — a fatal handler firing between
    // tests (after a per-test spy would have been restored) can't really exit.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterAll(() => {
    // Strip the unhandledRejection/uncaughtException handlers installFatalHandlers
    // added, BEFORE restoring the real process.exit — so no stray rejection during
    // teardown can fire a real exit. Only remove non-baseline (vitest's) listeners.
    process
      .listeners('unhandledRejection')
      .filter((l) => !baselineUnhandled.includes(l))
      .forEach((l) => process.removeListener('unhandledRejection', l));
    process
      .listeners('uncaughtException')
      .filter((l) => !baselineUncaught.includes(l))
      .forEach((l) => process.removeListener('uncaughtException', l));
    exitSpy.mockRestore();
    process.exitCode = 0;
  });

  beforeEach(() => {
    vi.resetModules();
    exitSpy.mockClear();
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

  afterEach(() => {
    // Don't leak a non-zero exit code to the forked worker's natural exit.
    process.exitCode = 0;
  });

  it('force-exits when native handles are still open (isLbugReady true)', async () => {
    isLbugReadyMock.mockReturnValue(true);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT force-exit when no handles are open (isLbugReady false) — soft return preserved', async () => {
    isLbugReadyMock.mockReturnValue(false);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
