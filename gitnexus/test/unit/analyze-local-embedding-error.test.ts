/**
 * Tests for the local-embedding-runtime blocker error path in the
 * `analyzeCommand` CLI (#1515 / #1987 review follow-up).
 *
 * On macOS Intel (darwin/x64) `initEmbedder` throws a GitNexus-authored blocker
 * before importing transformers.js. The analyze error handler must route that
 * message to a clean `local-embedding-unsupported` message (exit 1) — not the
 * generic MODULE_NOT_FOUND "installation may be corrupt" hint, and not the
 * network-heuristic HF-download branch — so the explicit platform message wins.
 *
 * Mirrors the shape of analyze-wal-error.test.ts:
 *   - vi.mock the heavy dependencies so no real DB / git is touched
 *   - drive `analyzeCommand` with a mocked `runFullAnalysis` that rejects
 *   - assert on process.exitCode and the captured logger records
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalEmbeddingRuntimeBlocker } from '../../src/core/embeddings/runtime-support.js';

const runFullAnalysisMock = vi.fn();
// Controllable so the dual-match scenario can force the network heuristic to
// also match the blocker error and prove the blocker branch still wins.
const isHfDownloadFailureMock = vi.fn(() => false);

// Drive analyze's auto-install / capability gate (#2372). Defaults keep the
// existing tests on the happy path (package-sourced, loadable → gate skipped).
const resolveEmbeddingRuntimeMock = vi.fn<() => { source: string } | null>(() => ({
  source: 'package',
}));
const isPrefixRuntimeLoadableMock = vi.fn(() => true);
const installEmbeddingRuntimeMock = vi.fn(async () => undefined);
vi.mock('../../src/core/embeddings/runtime-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/embeddings/runtime-install.js')>()),
  resolveEmbeddingRuntime: () => resolveEmbeddingRuntimeMock(),
  isPrefixRuntimeLoadable: () => isPrefixRuntimeLoadableMock(),
  installEmbeddingRuntime: (...args: unknown[]) => installEmbeddingRuntimeMock(...args),
  getEmbeddingRuntimeDir: () => '/fake/embedding-runtime',
}));

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
  // Stub class for the CLI's `err instanceof LbugWipeError` branch (#2409,
  // tri-review 4669518496 P2-4): instanceof must evaluate (not TypeError on
  // an undefined binding) and correctly NOT claim this suite's errors. Same
  // pattern as the RegistryNameCollisionError stub below.
  LbugWipeError: class LbugWipeError extends Error {},
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

// analyze.ts imports isHfDownloadFailure from hf-env.js, which transitively
// pulls gitnexus-shared. Mock it to break the chain and to drive the
// blocker-vs-HF ordering test below. isLocalEmbeddingRuntimeBlockerMessage
// (runtime-support.js) is intentionally NOT mocked — the real branch must fire.
vi.mock('../../src/core/embeddings/hf-env.js', () => ({
  isHfDownloadFailure: isHfDownloadFailureMock,
}));

const blockerMessage = getLocalEmbeddingRuntimeBlocker({
  platform: 'darwin',
  arch: 'x64',
}) as string;

describe('analyzeCommand local-embedding-runtime error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    isHfDownloadFailureMock.mockReset();
    isHfDownloadFailureMock.mockReturnValue(false);
    resolveEmbeddingRuntimeMock.mockReset();
    resolveEmbeddingRuntimeMock.mockReturnValue({ source: 'package' });
    isPrefixRuntimeLoadableMock.mockReset();
    isPrefixRuntimeLoadableMock.mockReturnValue(true);
    installEmbeddingRuntimeMock.mockReset();
    installEmbeddingRuntimeMock.mockResolvedValue(undefined);
    process.exitCode = undefined;
    // Ensure ensureHeap() short-circuits (heap already at target size)
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('routes the blocker to a clean local-embedding-unsupported message (exit 1)', async () => {
    runFullAnalysisMock.mockRejectedValue(new Error(blockerMessage));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);

    const records = cap.records();
    const blockerRecord = records.find((r) => r.recoveryHint === 'local-embedding-unsupported');
    expect(blockerRecord).toBeDefined();
    expect(typeof blockerRecord?.msg === 'string' && blockerRecord.msg).toMatch(/macOS Intel/);

    cap.restore();
  });

  it('does NOT fall through to the module-not-found "installation may be corrupt" hint', async () => {
    runFullAnalysisMock.mockRejectedValue(new Error(blockerMessage));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    const records = cap.records();
    const corruptRecord = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('installation may be corrupt'),
    );
    expect(corruptRecord).toBeUndefined();

    cap.restore();
  });

  it('wins over the HF-download branch even when isHfDownloadFailure also matches (R4 ordering)', async () => {
    // Force the network heuristic to claim the blocker error too. Because the
    // blocker check is ordered before isHfDownloadFailure, the blocker branch
    // must still win — this is the only scenario that falsifies a wrong order.
    isHfDownloadFailureMock.mockReturnValue(true);
    runFullAnalysisMock.mockRejectedValue(new Error(blockerMessage));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);

    const records = cap.records();
    expect(records.some((r) => r.recoveryHint === 'local-embedding-unsupported')).toBe(true);
    // The HF-download branch must NOT have fired.
    expect(records.some((r) => r.recoveryHint === 'hf-endpoint-unreachable')).toBe(false);

    cap.restore();
  });

  it('does NOT route unrelated errors through the local-embedding branch', async () => {
    runFullAnalysisMock.mockRejectedValue(
      new Error('Some unexpected failure unrelated to embeddings'),
    );

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);

    const records = cap.records();
    expect(records.some((r) => r.recoveryHint === 'local-embedding-unsupported')).toBe(false);

    cap.restore();
  });
});

describe('analyzeCommand — prefix-runtime capability gate (#2372)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    isHfDownloadFailureMock.mockReset().mockReturnValue(false);
    resolveEmbeddingRuntimeMock.mockReset();
    isPrefixRuntimeLoadableMock.mockReset();
    installEmbeddingRuntimeMock.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('fails fast without installing when nothing is installed and the prefix is unloadable', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValue(null);
    isPrefixRuntimeLoadableMock.mockReturnValue(false);

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);
    expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
    const record = cap.records().find((r) => r.recoveryHint === 'local-embedding-stack-missing');
    expect(typeof record?.msg === 'string' && record.msg).toMatch(/module\.registerHooks/);
    cap.restore();
  });

  it('fails fast on a resolved-but-unloadable prefix (the previously-uncaught state)', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValue({ source: 'runtime-prefix' });
    isPrefixRuntimeLoadableMock.mockReturnValue(false);

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);
    expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
    expect(cap.records().some((r) => r.recoveryHint === 'local-embedding-stack-missing')).toBe(
      true,
    );
    cap.restore();
  });

  it('installs with a shorter-than-default timeout when nothing is installed and the prefix is loadable', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValue(null);
    isPrefixRuntimeLoadableMock.mockReturnValue(true);
    // Reject afterwards so analyze bails right after the install, isolating the gate.
    runFullAnalysisMock.mockRejectedValue(new Error('stop after install'));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS } =
      await import('../../src/core/embeddings/runtime-install.js');
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { embeddings: true });

    expect(installEmbeddingRuntimeMock).toHaveBeenCalledTimes(1);
    // analyze must pass the shorter deadline so a blackholed proxy can't stall
    // the run for the 10-minute default.
    const timeoutArg = installEmbeddingRuntimeMock.mock.calls[0][1] as number;
    expect(timeoutArg).toBe(ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS);
    cap.restore();
  });
});
