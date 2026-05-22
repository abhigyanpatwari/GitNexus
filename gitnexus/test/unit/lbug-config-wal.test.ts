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
  it('disables auto-checkpoint by default', () => {
    const Database = vi.fn(function (this: any) {});
    const lbugModule = { Database } as any;

    createLbugDatabase(lbugModule, '/tmp/lbug-default');

    expect(Database).toHaveBeenCalledWith(
      '/tmp/lbug-default',
      0,
      false,
      false,
      expect.any(Number),
      false,
      -1,
      true,
      true,
    );
  });

  it.each([
    ['1', true],
    ['on', true],
    ['true', true],
    ['0', false],
    ['off', false],
    ['false', false],
    ['invalid', false],
  ])('respects GITNEXUS_LBUG_AUTO_CHECKPOINT=%s', (raw, expectedAutoCheckpoint) => {
    try {
      vi.stubEnv('GITNEXUS_LBUG_AUTO_CHECKPOINT', raw);
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-env');

      expect(Database).toHaveBeenCalledWith(
        '/tmp/lbug-env',
        0,
        false,
        false,
        expect.any(Number),
        expectedAutoCheckpoint,
        -1,
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
      false,
      -1,
      false,
      true,
    );
  });
});
