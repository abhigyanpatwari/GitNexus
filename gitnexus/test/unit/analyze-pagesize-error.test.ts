/**
 * Tests for non-4K page-size buffer-manager error handling in `analyzeCommand`
 * (#1231).
 *
 * On kernels with 16 KiB pages (Raspberry Pi 5, Asahi Linux) a
 * @ladybugdb/core < 0.18.0 buffer manager fails to release evicted frames
 * (madvise EINVAL) and analyze aborts mid-COPY with a raw native message.
 * The CLI must catch that shape before the generic error path and render an
 * actionable message: what the OS page size is, and whether the fix is
 * upgrading (@ladybugdb/core < 0.18.0) or reporting (>= 0.18.0).
 *
 * Mirrors the mock shape of analyze-wal-error.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();

vi.mock('../../src/core/run-analyze.js', () => ({
  runFullAnalysis: runFullAnalysisMock,
}));

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

// analyze.ts imports isHfDownloadFailure from hf-env.js, which in turn imports
// from gitnexus-shared (not linked in dev). Mock the module to break the chain.
vi.mock('../../src/core/embeddings/hf-env.js', () => ({
  isHfDownloadFailure: vi.fn(() => false),
}));

// Pin the fingerprint so assertions do not depend on the dev environment's
// installed @ladybugdb/core.
const fingerprintMock = vi.fn(() => ({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  gitnexus: 'test',
  ladybugdb: '0.17.1',
}));
vi.mock('../../src/core/platform/capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/platform/capabilities.js')>()),
  getRuntimeFingerprint: fingerprintMock,
}));

const PI5_COPY_ERROR =
  'COPY failed for File: Buffer manager exception: Releasing physical memory ' +
  'associated with a frame failed with error code -1: Invalid argument.';

describe('analyzeCommand non-4K page-size error handling (#1231)', () => {
  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    process.exitCode = undefined;
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  it('recommends upgrading when @ladybugdb/core < 0.18.0 hits the frame-release error', async () => {
    fingerprintMock.mockReturnValue({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      gitnexus: 'test',
      ladybugdb: '0.17.1',
    });
    runFullAnalysisMock.mockRejectedValue(new Error(PI5_COPY_ERROR));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    const hint = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('failed to release frame memory'),
    );
    expect(hint).toBeDefined();
    expect(hint?.msg).toContain('0.18.0');
    expect(hint?.msg).toContain('npm install -g gitnexus@latest');
    // Raw stack trace must NOT appear via cliError
    const stackRecord = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('at analyzeCommand'),
    );
    expect(stackRecord).toBeUndefined();

    cap.restore();
  });

  it('asks for a bug report when @ladybugdb/core >= 0.18.0 still hits the error', async () => {
    fingerprintMock.mockReturnValue({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      gitnexus: 'test',
      ladybugdb: '0.18.0',
    });
    runFullAnalysisMock.mockRejectedValue(new Error(PI5_COPY_ERROR));

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    const hint = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('failed to release frame memory'),
    );
    expect(hint).toBeDefined();
    expect(hint?.msg).toContain('issues/1231');
    expect(hint?.msg).not.toContain('npm install -g gitnexus@latest');

    cap.restore();
  });

  it('does NOT route buffer-pool exhaustion through the page-size handler', async () => {
    runFullAnalysisMock.mockRejectedValue(
      new Error(
        'COPY failed for File: Buffer manager exception: Unable to allocate memory! ' +
          'The buffer pool is full and no memory could be freed!',
      ),
    );

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    const records = cap.records();
    expect(
      records.some(
        (r) => typeof r.msg === 'string' && r.msg.includes('failed to release frame memory'),
      ),
    ).toBe(false);

    cap.restore();
  });
});
