import { describe, expect, it, vi } from 'vitest';
import { createLbugDatabase, isWalCorruptionError } from '../../src/core/lbug/lbug-config.js';

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
  it('enables auto-checkpoint by default and uses default threshold', () => {
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
      -1,
      true,
      true,
    );
  });

  it.each([
    ['0', 0],
    ['1024', 1024],
    ['-1', -1],
    ['invalid', -1],
    ['', -1],
  ])('respects GITNEXUS_LBUG_CHECKPOINT_THRESHOLD=%s', (raw, expectedCheckpointThreshold) => {
    try {
      vi.stubEnv('GITNEXUS_LBUG_CHECKPOINT_THRESHOLD', raw);
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
      -1,
      false,
      true,
    );
  });
});
