import { describe, expect, it, vi } from 'vitest';
import {
  createLbugDatabase,
  isLbugCheckpointIoError,
  isWalCorruptionError,
} from '../../src/core/lbug/lbug-config.js';
import { _captureLogger } from '../../src/core/logger.js';

const DEFAULT_THRESHOLD = 64 * 1024 * 1024;

describe('isWalCorruptionError', () => {
  it.each([
    [
      'Corrupted wal file',
      'Runtime exception: Corrupted wal file. Read out invalid WAL record type.',
    ],
    ['invalid WAL record', 'Error: invalid WAL record type'],
    ['WAL checksum', 'Checksum verification failed, the WAL file is corrupted.'],
    ['WAL + corrupt', 'the WAL file is corrupted'],
  ])('matches WAL corruption: %s', (_label, msg) => {
    expect(isWalCorruptionError(msg)).toBe(true);
    expect(isWalCorruptionError(new Error(msg))).toBe(true);
  });

  it.each([
    ['lock error', 'Could not set lock on file : /path/to/db'],
    ['generic', 'Query failed'],
    ['not found', 'LadybugDB not found at /path'],
    ['checksum without WAL', 'Checksum verification failed for parquet file'],
    ['permission path with WAL', "EACCES: permission denied '/path/to/wal'"],
    ['schema mismatch WAL', 'schema version mismatch in WAL'],
  ])('does not match non-WAL error: %s', (_label, msg) => {
    expect(isWalCorruptionError(msg)).toBe(false);
  });

  it('handles non-string input', () => {
    expect(isWalCorruptionError(undefined)).toBe(false);
    expect(isWalCorruptionError(null)).toBe(false);
    expect(isWalCorruptionError(42)).toBe(false);
    expect(isWalCorruptionError(new Error('ok'))).toBe(false);
  });
});

describe('createLbugDatabase WAL replay option', () => {
  it('enables auto-checkpoint by default and uses default threshold (64 MiB)', () => {
    const Database = vi.fn(function (this: any) {});
    const lbugModule = { Database } as any;

    createLbugDatabase(lbugModule, '/tmp/lbug-default');

    expect(Database).toHaveBeenCalledWith(
      '/tmp/lbug-default',
      0,
      false,
      false,
      expect.any(Number),
      true,
      DEFAULT_THRESHOLD,
      true,
      true,
    );
  });

  it.each([
    ['0', 0],
    ['1024', 1024],
    ['-1', -1],
    ['invalid', DEFAULT_THRESHOLD],
    ['', DEFAULT_THRESHOLD],
  ])('respects GITNEXUS_WAL_CHECKPOINT_THRESHOLD=%s', (raw, expectedCheckpointThreshold) => {
    try {
      vi.stubEnv('GITNEXUS_WAL_CHECKPOINT_THRESHOLD', raw);
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-env');

      expect(Database).toHaveBeenCalledWith(
        '/tmp/lbug-env',
        0,
        false,
        false,
        expect.any(Number),
        true,
        expectedCheckpointThreshold,
        true,
        true,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('warns and falls back to default when GITNEXUS_WAL_CHECKPOINT_THRESHOLD is invalid', () => {
    const cap = _captureLogger();
    try {
      vi.stubEnv('GITNEXUS_WAL_CHECKPOINT_THRESHOLD', 'invalid');
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-invalid');

      const warn = cap
        .records()
        .find(
          (r) =>
            typeof r.msg === 'string' &&
            r.msg.includes('Ignoring invalid GITNEXUS_WAL_CHECKPOINT_THRESHOLD'),
        );
      expect(warn).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
      cap.restore();
    }
  });

  it('does NOT warn when GITNEXUS_WAL_CHECKPOINT_THRESHOLD is empty (treated as unset)', () => {
    const cap = _captureLogger();
    try {
      vi.stubEnv('GITNEXUS_WAL_CHECKPOINT_THRESHOLD', '');
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-empty');

      const warn = cap
        .records()
        .find(
          (r) =>
            typeof r.msg === 'string' &&
            r.msg.includes('Ignoring invalid GITNEXUS_WAL_CHECKPOINT_THRESHOLD'),
        );
      expect(warn).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      cap.restore();
    }
  });

  it('passes throwOnWalReplayFailure and checksum constructor args explicitly', () => {
    const Database = vi.fn(function (this: any) {});
    const lbugModule = { Database } as any;

    createLbugDatabase(lbugModule, '/tmp/lbug', {
      readOnly: true,
      throwOnWalReplayFailure: false,
    });

    expect(Database).toHaveBeenCalledWith(
      '/tmp/lbug',
      0,
      false,
      true,
      expect.any(Number),
      true,
      DEFAULT_THRESHOLD,
      false,
      true,
    );
  });
});

// ─── Finding 8: strict + permissive checkpoint IO matchers ─────────────────
describe('isLbugCheckpointIoError', () => {
  it.each([
    [
      'native rename failure (v0.16.x exact)',
      'Runtime exception: IO exception: Error renaming file /repo/.gitnexus/lbug.wal to /repo/.gitnexus/lbug.wal.checkpoint. ErrorMessage: Permission denied',
    ],
    [
      'native remove failure (v0.16.x exact)',
      'Runtime exception: IO exception: Error removing directory or file /repo/.gitnexus/lbug.wal.checkpoint.  Error Message: Permission denied',
    ],
  ])('matches strict %s', (_label, msg) => {
    expect(isLbugCheckpointIoError(msg)).toBe(true);
    expect(isLbugCheckpointIoError(new Error(msg))).toBe(true);
  });

  it('matches permissive fallback for hypothetical message drift', () => {
    // Permissive matcher accepts any IO-exception-shaped message mentioning .wal.checkpoint.
    const drift =
      'Some new wrapper preamble :: IO exception when finalizing /repo/.gitnexus/lbug.wal.checkpoint';
    expect(isLbugCheckpointIoError(drift)).toBe(true);
  });

  it('does NOT match unrelated IO errors', () => {
    expect(
      isLbugCheckpointIoError(
        'Runtime exception: IO exception: Error renaming file /repo/data.tmp to /repo/data.tmp.bak',
      ),
    ).toBe(false);
    expect(isLbugCheckpointIoError('Some other error')).toBe(false);
    expect(isLbugCheckpointIoError(undefined)).toBe(false);
  });
});
