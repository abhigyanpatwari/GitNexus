import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
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
}));

vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

// These tests invoke analyzeCommand directly (programmatic-call path), which
// bypasses the commander preAction hook. So they exercise analyzeCommandImpl's
// own validation/normalization and the confirmation-message gating — the
// direct-call half of the fixes. The hook half — the dims crash-path on the
// REAL program.parse path — is exercised end-to-end in
// test/integration/analyze-embedding-flags-e2e.test.ts (it would have caught
// the original raw-crash regression). The canonical dims normalization is
// unit-tested in embedding-dims.test.ts. (The postAction DIMS baseline restore
// is in-process-parseAsync-only and remains covered by code-read.)
const EMBED_ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

describe('analyzeCommand custom embedding endpoint flags', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    runFullAnalysisMock.mockResolvedValue({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
    // Start every case from a clean embedding env so ambient values can't mask
    // a regression (and restore the host's afterwards).
    for (const k of EMBED_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of EMBED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const importCmd = async () => (await import('../../src/cli/analyze.js')).analyzeCommand;

  const captureStderr = () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      text: () => spy.mock.calls.map(([c]) => (typeof c === 'string' ? c : c.toString())).join(''),
      restore: () => spy.mockRestore(),
    };
  };

  const captureLog = () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    return {
      text: () => spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n'),
      restore: () => spy.mockRestore(),
    };
  };

  // ── URL validation (analyzeCommandImpl) ────────────────────────────

  it.each([
    ['', 'must not be empty'],
    ['not a url', 'not a valid URL'],
    ['ftp://host/v1', 'must use http:// or https://'],
  ])('rejects --embedding-base-url %j before analysis', async (embeddingBaseUrl, expected) => {
    const err = captureStderr();
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, { embeddingBaseUrl });

    expect(process.exitCode).toBe(1);
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
    expect(err.text()).toContain(expected);
    err.restore();
  });

  it('accepts a valid http(s) base URL with model and proceeds to analysis', async () => {
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, {
      embeddings: true,
      embeddingBaseUrl: 'http://10.0.0.1:11434/v1',
      embeddingModel: 'qwen3',
    });

    expect(process.exitCode).not.toBe(1);
    expect(runFullAnalysisMock).toHaveBeenCalledTimes(1);
  });

  // ── Model / token emptiness ────────────────────────────────────────

  it('rejects a whitespace-only --embedding-model', async () => {
    const err = captureStderr();
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, { embeddingModel: '   ' });

    expect(process.exitCode).toBe(1);
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
    expect(err.text()).toContain('--embedding-model must not be empty');
    err.restore();
  });

  it('rejects an empty --embedding-auth-token', async () => {
    const err = captureStderr();
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, { embeddingAuthToken: '' });

    expect(process.exitCode).toBe(1);
    expect(runFullAnalysisMock).not.toHaveBeenCalled();
    expect(err.text()).toContain('--embedding-auth-token must not be empty');
    err.restore();
  });

  // ── Dims validation on the direct-call path (finding #1) ───────────

  it.each(['1e3', 'abc', '0', '-5', '3.5'])(
    'rejects invalid --embedding-dims %j with a friendly error (no crash)',
    async (embeddingDims) => {
      const err = captureStderr();
      const analyzeCommand = await importCmd();

      await analyzeCommand(undefined, { embeddings: true, embeddingDims });

      expect(process.exitCode).toBe(1);
      expect(runFullAnalysisMock).not.toHaveBeenCalled();
      expect(err.text()).toContain('--embedding-dims must be a positive integer');
      err.restore();
    },
  );

  it('accepts a valid --embedding-dims and proceeds', async () => {
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, { embeddings: true, embeddingDims: '4096' });

    expect(process.exitCode).not.toBe(1);
    expect(runFullAnalysisMock).toHaveBeenCalledTimes(1);
  });

  // ── Credential masking in the confirmation line (finding #2) ───────

  it('masks userinfo credentials in the confirmation line', async () => {
    const log = captureLog();
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, {
      embeddings: true,
      embeddingBaseUrl: 'http://user:s3cret@host:11434/v1',
      embeddingModel: 'qwen3',
    });

    const out = log.text();
    expect(out).toContain('Using custom embedding endpoint');
    expect(out).toContain('host:11434');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('user:');
    log.restore();
  });

  // ── Confirmation gating (finding #5 / U6) ──────────────────────────

  it('does not print "Using custom embedding endpoint" when --embeddings is absent', async () => {
    const log = captureLog();
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, {
      embeddingBaseUrl: 'http://host/v1',
      embeddingModel: 'qwen3',
    });

    const out = log.text();
    expect(out).not.toContain('Using custom embedding endpoint');
    expect(out).toContain('no embeddings will be generated');
    log.restore();
  });

  it('does not print the confirmation on a plain run when env vars merely happen to be set', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://ambient/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'ambient';
    const log = captureLog();
    const analyzeCommand = await importCmd();

    // No embedding flags and no --embeddings: ambient env must not trigger it.
    await analyzeCommand(undefined, {});

    expect(log.text()).not.toContain('Using custom embedding endpoint');
    log.restore();
  });

  // ── CLI flag overrides ambient env during the run ──────────────────

  it('uses the CLI base URL over a pre-existing GITNEXUS_EMBEDDING_URL', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://old/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'old-model';
    const log = captureLog();
    const analyzeCommand = await importCmd();

    await analyzeCommand(undefined, {
      embeddings: true,
      embeddingBaseUrl: 'http://new/v1',
      embeddingModel: 'new-model',
    });

    const out = log.text();
    expect(out).toContain('http://new/v1');
    expect(out).toContain('new-model');
    expect(out).not.toContain('old/v1');
    expect(out).not.toContain('old-model');
    log.restore();
  });

  // ── Env snapshot/restore round-trip (finding #4 / U5) ──────────────

  it('restores GITNEXUS_EMBEDDING_* to their pre-call state after returning', async () => {
    const analyzeCommand = await importCmd();

    // Clean env (deleted in beforeEach); a validation early-return path
    // guarantees the finally-block restore runs.
    await analyzeCommand(undefined, {
      embeddingBaseUrl: 'http://host/v1',
      embeddingModel: 'qwen3',
      embeddingDims: 'bad', // fails after URL/MODEL were written → early return
    });

    expect(process.exitCode).toBe(1);
    for (const k of EMBED_ENV_KEYS) {
      expect(process.env[k]).toBeUndefined();
    }
  });
});
