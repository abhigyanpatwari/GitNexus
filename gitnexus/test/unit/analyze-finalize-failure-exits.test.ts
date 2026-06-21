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
 * Worker-safety (#2264 CI): the module is imported ONCE and the mocks are driven
 * per-test via `mockReturnValue`. The earlier `vi.resetModules()` + per-test
 * `await import('analyze.js')` re-instrumented the ENTIRE analyze module graph on
 * every test; under `--coverage` on the memory-constrained CI runner that
 * OOM/crashed the forked worker ("Worker exited unexpectedly"), even though it
 * passed locally. `analyzeCommand` also installs global fatal handlers
 * (installFatalHandlers) that call the REAL process.exit(1); we keep process.exit
 * spied for the whole file so one firing can't kill the worker, strip the handlers
 * it added in afterAll, and reset process.exitCode so the worker exits clean.
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
  closeLbugBeforeExit: vi.fn(async () => undefined),
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

// Imported ONCE (not re-imported per test) — see the worker-safety note above.
import { analyzeCommand } from '../../src/cli/analyze.js';

describe('analyzeCommand — finalize-failure must terminate, not hang (#2264 P1)', () => {
  // Snapshot the fatal-handler listeners present BEFORE this file ran (vitest's
  // own) so afterAll strips only the ones installFatalHandlers added.
  const baselineUnhandled = process.listeners('unhandledRejection');
  const baselineUncaught = process.listeners('uncaughtException');
  let exitSpy: MockInstance<typeof process.exit>;
  let savedNodeOptions: string | undefined;

  beforeAll(() => {
    // analyzeCommand calls ensureHeap(), which RE-EXECS the process — spawning
    // `node <heap-flags> <argv>` where argv is vitest's, killing the forked
    // worker — UNLESS NODE_OPTIONS already carries a heap cap (analyze.ts:498).
    // Locally a high V8 heap-size-limit also short-circuits it (analyze.ts:501),
    // which is why this only crashed on the memory-constrained CI runner. Pre-set
    // the cap so ensureHeap returns early — the same workaround cli-e2e uses
    // (#2264 CI). Restored in afterAll so a reused worker's later files are clean.
    savedNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
    // Mock process.exit for the WHOLE file — a fatal handler firing between tests
    // (after a per-test spy would have been restored) can't really exit.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterAll(() => {
    // Strip the handlers installFatalHandlers added BEFORE restoring the real
    // process.exit, so no stray rejection during teardown fires a real exit. Only
    // remove non-baseline (vitest's own) listeners.
    process
      .listeners('unhandledRejection')
      .filter((l) => !baselineUnhandled.includes(l))
      .forEach((l) => process.removeListener('unhandledRejection', l));
    process
      .listeners('uncaughtException')
      .filter((l) => !baselineUncaught.includes(l))
      .forEach((l) => process.removeListener('uncaughtException', l));
    exitSpy.mockRestore();
    process.env.NODE_OPTIONS = savedNodeOptions ?? '';
    process.exitCode = 0;
  });

  beforeEach(() => {
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
    await analyzeCommand(undefined, {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT force-exit when no handles are open (isLbugReady false) — soft return preserved', async () => {
    isLbugReadyMock.mockReturnValue(false);
    await analyzeCommand(undefined, {});
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('forwards a pre-set process.exitCode rather than the hardcoded fallback', async () => {
    // The alreadyUpToDate path returns WITHOUT setting process.exitCode or calling
    // process.exit (unlike the error catch, which always sets exitCode=1), so the
    // wrapper's force-exit must forward whatever exitCode is already set — proving
    // `process.exit(process.exitCode ?? 1)` reads exitCode and doesn't hardcode 1.
    // isLbugReady is forced true to drive the wrapper's force-exit on this path.
    isLbugReadyMock.mockReturnValue(true);
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
      ftsRepairedOnly: false,
      pipelineResult: { communityResult: undefined },
    });
    assertAnalysisFinalizedMock.mockResolvedValue(undefined);
    process.exitCode = 2;
    await analyzeCommand(undefined, {});
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
