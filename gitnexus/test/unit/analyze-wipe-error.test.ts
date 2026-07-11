/**
 * Tests for the LadybugDB wipe-failure path in the `analyzeCommand` CLI
 * (#2409, tri-review 4669518496 P2-4).
 *
 * When `wipeLbugDbFiles` cannot verify the DB file family is gone (another
 * process holds the index open — MCP server, serve worker, antivirus scan),
 * analyze rejects with a typed `LbugWipeError`. The CLI must render the
 * dedicated recovery-hint branch — classified by error TYPE, the repo norm
 * from #2385 — and must NOT fall through to the raw-stack
 * `writeFatalToStderr` fallback.
 *
 * Mirrors analyze-http-endpoint-error.test.ts:
 *   - vi.mock the heavy dependencies so no real DB / git is touched
 *   - drive `analyzeCommand` with a mocked `runFullAnalysis` that rejects
 *   - assert on process.exitCode and the captured logger records
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();

const resolveEmbeddingRuntimeMock = vi.fn<() => { source: string } | null>(() => ({
  source: 'package',
}));
const isPrefixRuntimeLoadableMock = vi.fn(() => true);
const installEmbeddingRuntimeMock = vi.fn(async () => undefined);
vi.mock('../../src/core/embeddings/runtime-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/embeddings/runtime-install.js')>()),
  resolveEmbeddingRuntime: () => resolveEmbeddingRuntimeMock(),
  isPrefixRuntimeLoadable: () => isPrefixRuntimeLoadableMock(),
  // Unlike the analyze-http-endpoint-error model, no args are forwarded: the
  // zero-arg mock's signature makes a spread call a type error (TS2556).
  installEmbeddingRuntime: () => installEmbeddingRuntimeMock(),
  getEmbeddingRuntimeDir: () => '/fake/embedding-runtime',
}));

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

// Preserve the REAL LbugWipeError (the CLI branch classifies by instanceof,
// so the test must throw the very class `cli/analyze.ts` imports); only the
// lifecycle functions are stubbed so no native DB is opened or closed.
vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
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

// analyze.ts imports isHfDownloadFailure from hf-env.js. Mock it to break the
// transitive gitnexus-shared chain (never claims the wipe error either way).
vi.mock('../../src/core/embeddings/hf-env.js', () => ({
  isHfDownloadFailure: vi.fn(() => false),
}));

describe('analyzeCommand LadybugDB wipe-failure handling (#2409, tri-review 4669518496)', () => {
  // Capture the host's NODE_OPTIONS once so afterEach can restore it cleanly.
  // Without the restore, beforeEach's append accumulated duplicate
  // --max-old-space-size tokens across tests (analyze-worker-pool-size.test.ts
  // pattern; #2424 review).
  const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;

  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    resolveEmbeddingRuntimeMock.mockReset().mockReturnValue({ source: 'package' });
    isPrefixRuntimeLoadableMock.mockReset().mockReturnValue(true);
    installEmbeddingRuntimeMock.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  afterEach(() => {
    if (ORIGINAL_NODE_OPTIONS === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = ORIGINAL_NODE_OPTIONS;
    }
  });

  it('routes a wipe failure to the dedicated recovery hint, not the raw-stack fallback', async () => {
    // Install the stderr spy BEFORE importing analyze.js: the module binds
    // `realStderrWrite = process.stderr.write.bind(...)` at load time, so a
    // later spy would miss the writeFatalToStderr fallback this test rules out.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { LbugWipeError } = await import('../../src/core/lbug/lbug-adapter.js');
      const survivor = '/repo/.gitnexus/lbug.wal';
      runFullAnalysisMock.mockRejectedValue(new LbugWipeError([survivor]));

      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { embeddings: true });

      expect(process.exitCode).toBe(1);
      const record = cap.records().find((r) => r.recoveryHint === 'lbug-wipe-failed');
      expect(record).toBeDefined();
      const text = typeof record?.msg === 'string' ? record.msg : '';
      // The self-contained LbugWipeError message is surfaced verbatim:
      // survivor path + the shared stop-MCP/AV-exclusion/re-run guidance
      // (lbugLockRemediation, this shipping review FIX 7).
      expect(text).toContain(survivor);
      expect(text).toMatch(/stop any GitNexus MCP or serve process/i);
      // The typed branch returns before writeFatalToStderr — the raw-stack
      // fallback header must never hit stderr for this error class.
      const stderrText = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(stderrText).not.toContain('Analysis failed');
      cap.restore();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('does not claim unrelated analyze failures for the wipe branch', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runFullAnalysisMock.mockRejectedValue(new Error('LadybugDB write failed'));

      const { _captureLogger } = await import('../../src/core/logger.js');
      const cap = _captureLogger();
      const { analyzeCommand } = await import('../../src/cli/analyze.js');

      await analyzeCommand(undefined, { embeddings: true });

      expect(process.exitCode).toBe(1);
      expect(cap.records().some((r) => r.recoveryHint === 'lbug-wipe-failed')).toBe(false);
      cap.restore();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
