/**
 * Tests for the custom HTTP embedding endpoint failure path in the
 * `analyzeCommand` CLI (#2385).
 *
 * When a `--embedding-base-url` is configured, HTTP mode never downloads a
 * model. A connection/timeout/DNS failure to that endpoint must surface an
 * endpoint-specific message — NOT the huggingface.co download remediation,
 * whose network heuristic (`fetch failed` / `ECONNREFUSED`) would otherwise
 * also match the wrapped endpoint error. The analyze handler discriminates on
 * the error *type* (`HttpEmbeddingError`), not its message text.
 *
 * Mirrors analyze-local-embedding-error.test.ts:
 *   - vi.mock the heavy dependencies so no real DB / git is touched
 *   - drive `analyzeCommand` with a mocked `runFullAnalysis` that rejects
 *   - assert on process.exitCode and the captured logger records
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();
// Controls the HF network heuristic so the gate/ordering scenarios can force it
// to also claim a plain network error and prove the endpoint branch / mode gate
// still win.
const isHfDownloadFailureMock = vi.fn(() => false);
// Controls isHttpMode so the HF-branch gate (`!isHttpMode()`) can be exercised
// in both states without setting real env vars. The real HttpEmbeddingError /
// isHttpEmbeddingError / safeUrl are preserved via importOriginal.
const isHttpModeMock = vi.fn(() => true);

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

// analyze.ts imports isHfDownloadFailure from hf-env.js. Mock it to break the
// transitive gitnexus-shared chain and to drive the HF-heuristic scenarios.
vi.mock('../../src/core/embeddings/hf-env.js', () => ({
  isHfDownloadFailure: isHfDownloadFailureMock,
}));

// Preserve the real HttpEmbeddingError / isHttpEmbeddingError / safeUrl; only
// override isHttpMode so the mode gate can be flipped per test.
vi.mock('../../src/core/embeddings/http-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/embeddings/http-client.js')>()),
  isHttpMode: () => isHttpModeMock(),
}));

describe('analyzeCommand custom HTTP endpoint error handling (#2385)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    isHfDownloadFailureMock.mockReset().mockReturnValue(false);
    isHttpModeMock.mockReset().mockReturnValue(true);
    resolveEmbeddingRuntimeMock.mockReset().mockReturnValue({ source: 'package' });
    isPrefixRuntimeLoadableMock.mockReset().mockReturnValue(true);
    installEmbeddingRuntimeMock.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('routes an endpoint connection failure to a clean endpoint message (R1)', async () => {
    const { HttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
    runFullAnalysisMock.mockRejectedValue(
      new HttpEmbeddingError(
        'Embedding request failed (http://127.0.0.1:1/v1/embeddings, batch 0): fetch failed',
      ),
    );

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);
    const record = cap.records().find((r) => r.recoveryHint === 'http-embedding-endpoint-error');
    expect(record).toBeDefined();
    // The masked URL from the thrown message is surfaced verbatim.
    expect(typeof record?.msg === 'string' && record.msg).toContain('127.0.0.1:1');
    cap.restore();
  });

  it('routes a malformed GITNEXUS_EMBEDDING_DIMS to a clean config message, not endpoint/HF (R3)', async () => {
    // readConfig() throws a plain Error on a malformed env DIMS; it surfaces from
    // the embedding pipeline into this catch. It is a config mistake, not an
    // endpoint failure, so it must get its own clean message — never the endpoint
    // or HF branch. (isHttpMode() no longer throws, so the crash at analyze:1109
    // that this used to be is gone; the error now reaches here.)
    runFullAnalysisMock.mockRejectedValue(
      new Error('GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "1024abc"'),
    );

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    expect(records.some((r) => r.recoveryHint === 'embedding-dims-invalid')).toBe(true);
    expect(records.some((r) => r.recoveryHint === 'http-embedding-endpoint-error')).toBe(false);
    expect(records.some((r) => r.recoveryHint === 'hf-endpoint-unreachable')).toBe(false);
    const record = records.find((r) => r.recoveryHint === 'embedding-dims-invalid');
    expect(typeof record?.msg === 'string' && record.msg).toContain('GITNEXUS_EMBEDDING_DIMS');
    cap.restore();
  });

  it('does not mislabel a reached-but-failed endpoint as "could not be reached"', async () => {
    // A dimension mismatch means the endpoint WAS reached and answered — the
    // message must not assert unreachability, and must surface the real reason
    // (which itself carries the fix hint). Regression guard for the #2385 fix.
    const { HttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
    runFullAnalysisMock.mockRejectedValue(
      new HttpEmbeddingError(
        'Embedding dimension mismatch: endpoint returned 512d vector, but expected 1024d. ' +
          'Update GITNEXUS_EMBEDDING_DIMS to match your model output.',
      ),
    );

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);
    const record = cap.records().find((r) => r.recoveryHint === 'http-embedding-endpoint-error');
    expect(record).toBeDefined();
    const text = typeof record?.msg === 'string' ? record.msg : '';
    // Surfaces the real reason...
    expect(text).toContain('dimension mismatch');
    // ...without falsely claiming the endpoint was unreachable.
    expect(text).not.toMatch(/could not be reached|unreachable/i);
    cap.restore();
  });

  it('never mentions huggingface for an endpoint failure, even if the HF heuristic matches (R2, R3)', async () => {
    // Force the HF network heuristic to also claim this error. The typed
    // endpoint branch is ordered first, so HF guidance must not appear.
    isHfDownloadFailureMock.mockReturnValue(true);
    const { HttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
    runFullAnalysisMock.mockRejectedValue(
      new HttpEmbeddingError(
        'Embedding request failed (http://127.0.0.1:1/v1/embeddings, batch 0): fetch failed',
      ),
    );

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    const records = cap.records();
    expect(records.some((r) => r.recoveryHint === 'http-embedding-endpoint-error')).toBe(true);
    expect(records.some((r) => r.recoveryHint === 'hf-endpoint-unreachable')).toBe(false);
    expect(records.every((r) => !(typeof r.msg === 'string' && /huggingface/i.test(r.msg)))).toBe(
      true,
    );
    cap.restore();
  });

  it('suppresses the HF branch for a raw network error while in HTTP mode (R3 gate)', async () => {
    // A plain (untyped) network error while a custom endpoint is configured:
    // the endpoint branch keys on the type so it does not fire, and the HF
    // branch is gated on !isHttpMode() so it must not fire either.
    isHttpModeMock.mockReturnValue(true);
    isHfDownloadFailureMock.mockReturnValue(true);
    runFullAnalysisMock.mockRejectedValue(new Error('fetch failed'));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    const records = cap.records();
    expect(records.some((r) => r.recoveryHint === 'hf-endpoint-unreachable')).toBe(false);
    expect(records.some((r) => r.recoveryHint === 'http-embedding-endpoint-error')).toBe(false);
    cap.restore();
  });

  it('leaves the real HF-download path unchanged when HTTP mode is inactive (R4)', async () => {
    // Local embedder (no custom endpoint): a genuine HF download network error
    // must still show the huggingface guidance.
    isHttpModeMock.mockReturnValue(false);
    isHfDownloadFailureMock.mockReturnValue(true);
    runFullAnalysisMock.mockRejectedValue(new Error('TypeError: fetch failed'));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    expect(records.some((r) => r.recoveryHint === 'hf-endpoint-unreachable')).toBe(true);
    expect(records.some((r) => r.recoveryHint === 'http-embedding-endpoint-error')).toBe(false);
    cap.restore();
  });

  it('does not capture unrelated HTTP-mode errors in the endpoint branch (R5)', async () => {
    isHttpModeMock.mockReturnValue(true);
    runFullAnalysisMock.mockRejectedValue(new Error('LadybugDB write failed'));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, { embeddings: true });

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    expect(records.some((r) => r.recoveryHint === 'http-embedding-endpoint-error')).toBe(false);
    cap.restore();
  });
});
