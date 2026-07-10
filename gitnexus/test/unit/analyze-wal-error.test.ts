/**
 * Tests for WAL corruption error handling in the `analyzeCommand` CLI.
 *
 * Before this fix, a WAL corruption error surfaced as a raw stack-trace dump.
 * After the fix, it is caught before the generic error path and rendered as
 * a clean, actionable message telling the user to run `gitnexus analyze --force`.
 *
 * Mirrors the test shape of analyze-worker-timeout.test.ts:
 *   - vi.mock the heavy dependencies so no real DB / git is touched
 *   - drive `analyzeCommand` with a mocked `runFullAnalysis` that throws
 *   - assert on process.exitCode and the logged output
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runFullAnalysisMock = vi.fn();

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

// analyze.ts imports isHfDownloadFailure from hf-env.js, which in turn imports
// from gitnexus-shared (not linked in dev). Mock the module to break the chain.
vi.mock('../../src/core/embeddings/hf-env.js', () => ({
  isHfDownloadFailure: vi.fn(() => false),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('analyzeCommand WAL corruption error handling', () => {
  // Capture the host's NODE_OPTIONS once so afterEach can restore it cleanly.
  // Without the restore, beforeEach's append accumulated duplicate
  // --max-old-space-size tokens across tests (analyze-worker-pool-size.test.ts
  // pattern; #2424 review).
  const ORIGINAL_NODE_OPTIONS = process.env.NODE_OPTIONS;

  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    process.exitCode = undefined;
    // Ensure ensureHeap() short-circuits (heap already at target size)
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  });

  afterEach(() => {
    if (ORIGINAL_NODE_OPTIONS === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = ORIGINAL_NODE_OPTIONS;
    }
  });

  it('surfaces a clean recovery message on a re-wrapped WAL corruption error', async () => {
    // This error shape is what lbug-adapter throws after detecting WAL corruption
    // in doInitLbug and re-wrapping it with the recovery suggestion.
    const walError = new Error(
      'LadybugDB WAL corruption detected at /repo/.gitnexus/lbug. ' +
        'Run `gitnexus analyze` to rebuild the index.\n' +
        '  Original error: Runtime exception: Corrupted wal file.',
    );
    runFullAnalysisMock.mockRejectedValue(walError);

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);

    const records = cap.records();
    const walRecord = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('gitnexus analyze --force'),
    );
    expect(walRecord).toBeDefined();

    // Raw stack trace must NOT appear via cliError
    const stackRecord = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('at analyzeCommand'),
    );
    expect(stackRecord).toBeUndefined();

    cap.restore();
  });

  it('surfaces a clean recovery message when the native WAL error fires directly', async () => {
    // isWalCorruptionError fires on the native engine message before re-wrapping.
    const nativeWalError = new Error(
      'Runtime exception: Corrupted wal file. Read out invalid WAL record type.',
    );
    runFullAnalysisMock.mockRejectedValue(nativeWalError);

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);

    const records = cap.records();
    const walRecord = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('gitnexus analyze --force'),
    );
    expect(walRecord).toBeDefined();

    cap.restore();
  });

  it('does NOT route non-WAL errors through the WAL handler', async () => {
    const genericError = new Error('Some unexpected failure unrelated to WAL');
    runFullAnalysisMock.mockRejectedValue(genericError);

    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    const { analyzeCommand } = await import('../../src/cli/analyze.js');

    await analyzeCommand(undefined, {});

    expect(process.exitCode).toBe(1);

    // The WAL recovery message must NOT appear for unrelated errors
    const records = cap.records();
    const walRecord = records.find(
      (r) => typeof r.msg === 'string' && r.msg.includes('gitnexus analyze --force'),
    );
    expect(walRecord).toBeUndefined();

    cap.restore();
  });

  it('recommends --wal-checkpoint-threshold on Ladybug checkpoint I/O failures', async () => {
    runFullAnalysisMock.mockRejectedValue(
      new Error(
        'Runtime exception: IO exception: Error renaming file /repo/.gitnexus/lbug.wal to /repo/.gitnexus/lbug.wal.checkpoint. ErrorMessage: Permission denied',
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
        (r) =>
          typeof r.msg === 'string' &&
          r.msg.includes('gitnexus analyze --wal-checkpoint-threshold'),
      ),
    ).toBe(true);

    cap.restore();
  });

  it('also recommends threshold on .wal.checkpoint remove failures', async () => {
    runFullAnalysisMock.mockRejectedValue(
      new Error(
        'Runtime exception: IO exception: Error removing directory or file /repo/.gitnexus/lbug.wal.checkpoint.  Error Message: Permission denied',
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
        (r) =>
          typeof r.msg === 'string' &&
          r.msg.includes('gitnexus analyze --wal-checkpoint-threshold'),
      ),
    ).toBe(true);

    cap.restore();
  });

  it('does not recommend threshold for non-checkpoint IO exceptions', async () => {
    runFullAnalysisMock.mockRejectedValue(
      new Error(
        'Runtime exception: IO exception: Error renaming file /repo/.gitnexus/data.tmp to /repo/.gitnexus/data.tmp.bak. ErrorMessage: Permission denied',
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
        (r) =>
          typeof r.msg === 'string' &&
          r.msg.includes('gitnexus analyze --wal-checkpoint-threshold'),
      ),
    ).toBe(false);

    cap.restore();
  });
});
