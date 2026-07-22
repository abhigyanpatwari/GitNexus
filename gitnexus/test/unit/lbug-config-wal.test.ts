import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLbugDatabase,
  estimateBufferPool,
  isLbugCheckpointIoError,
  isWalCorruptionError,
  setBufferPoolSizeHint,
  _setOsPageSizeForTests,
  bufferPoolExhaustionRemedy,
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
      expect.any(Number),
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
        expect.any(Number),
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
      expect.any(Number),
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

describe('createLbugDatabase buffer pool size (#2557)', () => {
  const GiB = 1024 * 1024 * 1024;

  // Pin a 4 KiB page so every expectation below is host-independent — on a
  // 16 KiB-page Apple Silicon runner the #2631 granule scaling would
  // otherwise multiply them by 4.
  beforeEach(() => _setOsPageSizeForTests(4096));
  afterEach(() => _setOsPageSizeForTests(undefined));

  const bufferPoolArg = (Database: ReturnType<typeof vi.fn>): unknown => Database.mock.calls[0][1];

  it.each([
    ['32 GiB machine caps at 2 GiB', 32 * GiB, 2 * GiB],
    ['1 GiB machine keeps the native-equivalent 80% bound', GiB, Math.floor(0.8 * GiB)],
    ['64 MiB container clamps up to the floor', 64 * 1024 * 1024, 64 * 1024 * 1024],
  ])('defaults to min(2 GiB, max(64 MiB, 0.8 * totalmem)): %s', (_label, totalmem, expected) => {
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(totalmem);
    try {
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-pool');

      expect(bufferPoolArg(Database)).toBe(expected);
    } finally {
      totalmemSpy.mockRestore();
    }
  });

  it.each([
    ['1073741824', 1073741824],
    ['0', 0],
    ['1536.9', 1536],
  ])('respects GITNEXUS_LBUG_BUFFER_POOL_SIZE=%s', (raw, expected) => {
    try {
      vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', raw);
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-pool-env');

      expect(bufferPoolArg(Database)).toBe(expected);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([['abc'], ['-5']])('warns and falls back to the default for invalid value %s', (raw) => {
    const cap = _captureLogger();
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
    try {
      vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', raw);
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-pool-invalid');

      expect(bufferPoolArg(Database)).toBe(2 * GiB);
      const warn = cap
        .records()
        .find(
          (r) =>
            typeof r.msg === 'string' &&
            r.msg.includes('Ignoring invalid GITNEXUS_LBUG_BUFFER_POOL_SIZE'),
        );
      expect(warn).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
      totalmemSpy.mockRestore();
      cap.restore();
    }
  });

  it('does NOT warn when GITNEXUS_LBUG_BUFFER_POOL_SIZE is empty (treated as unset)', () => {
    const cap = _captureLogger();
    try {
      vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', '');
      const Database = vi.fn(function (this: any) {});
      const lbugModule = { Database } as any;

      createLbugDatabase(lbugModule, '/tmp/lbug-pool-empty');

      const warn = cap
        .records()
        .find(
          (r) =>
            typeof r.msg === 'string' &&
            r.msg.includes('Ignoring invalid GITNEXUS_LBUG_BUFFER_POOL_SIZE'),
        );
      expect(warn).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      cap.restore();
    }
  });
});

describe('adaptive buffer pool hint', () => {
  const GiB = 1024 * 1024 * 1024;
  const MiB = 1024 * 1024;
  const bufferPoolArg = (Database: ReturnType<typeof vi.fn>): unknown => Database.mock.calls[0][1];

  beforeEach(() => _setOsPageSizeForTests(4096));
  afterEach(() => {
    setBufferPoolSizeHint(undefined);
    _setOsPageSizeForTests(undefined);
  });

  describe('estimateBufferPool', () => {
    it.each([
      ['tiny graph clamps up to the 256 MiB COPY-safety floor', 41, 256 * MiB],
      ['a graph under the floor still clamps up to 256 MiB', 40_000, 256 * MiB],
      ['mid graph scales linearly (100k elements * 4 KiB = 400 MiB)', 100_000, 100_000 * 4 * 1024],
      ['huge graph caps at the 2 GiB / 80%-RAM default', 10_000_000, 2 * GiB],
    ])('%s', (_label, elements, expected) => {
      const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
      try {
        expect(estimateBufferPool(elements)).toBe(expected);
      } finally {
        totalmemSpy.mockRestore();
      }
    });
  });

  it.each([
    ['a hint within range passes through', 512 * MiB, 512 * MiB],
    ['a hint below the COPY-safety floor clamps up to 256 MiB', 100 * MiB, 256 * MiB],
    ['a hint above the default clamps down to the 2 GiB cap', 8 * GiB, 2 * GiB],
  ])(
    'createLbugDatabase uses the clamped hint when no env override is set: %s',
    (_label, hint, expected) => {
      const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
      try {
        setBufferPoolSizeHint(hint);
        const Database = vi.fn(function (this: any) {});
        createLbugDatabase({ Database } as any, '/tmp/lbug-hint');
        expect(bufferPoolArg(Database)).toBe(expected);
      } finally {
        totalmemSpy.mockRestore();
      }
    },
  );

  it('env override wins over the hint (including 0 = native default)', () => {
    try {
      setBufferPoolSizeHint(128 * MiB);
      vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', '0');
      const Database = vi.fn(function (this: any) {});
      createLbugDatabase({ Database } as any, '/tmp/lbug-hint-env');
      expect(bufferPoolArg(Database)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to the default when the hint is cleared', () => {
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
    try {
      setBufferPoolSizeHint(128 * MiB);
      setBufferPoolSizeHint(undefined);
      const Database = vi.fn(function (this: any) {});
      createLbugDatabase({ Database } as any, '/tmp/lbug-hint-cleared');
      expect(bufferPoolArg(Database)).toBe(2 * GiB);
    } finally {
      totalmemSpy.mockRestore();
    }
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

// ─── #2631: page-size-scaled pool sizing (granule accounting) ───────────────
describe('page-size-scaled buffer pool sizing (#2631)', () => {
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;
  const bufferPoolArg = (Database: ReturnType<typeof vi.fn>): unknown => Database.mock.calls[0][1];

  afterEach(() => {
    setBufferPoolSizeHint(undefined);
    _setOsPageSizeForTests(undefined);
    vi.unstubAllEnvs();
  });

  it.each([
    ['64 KiB pages scale the floor ×16', 65536, 41, 16 * 256 * MiB],
    [
      '64 KiB pages scale the estimate ×16 (100k × 4 KiB × 16 = 6.4 GB)',
      65536,
      100_000,
      100_000 * 4 * 1024 * 16,
    ],
    ['16 KiB pages (Apple Silicon) scale the floor ×4', 16384, 41, 4 * 256 * MiB],
    ['4 KiB pages are byte-identical to the unscaled behavior', 4096, 100_000, 100_000 * 4 * 1024],
  ])('%s', (_label, pageSize, elements, expected) => {
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
    try {
      _setOsPageSizeForTests(pageSize);
      expect(estimateBufferPool(elements)).toBe(expected);
    } finally {
      totalmemSpy.mockRestore();
    }
  });

  it('the scaled cap is still bounded by 80% of RAM (64 KiB pages, huge graph)', () => {
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
    try {
      _setOsPageSizeForTests(65536);
      // min(2 GiB × 16, 0.8 × 32 GiB) = min(32 GiB, 25.6 GiB) = 25.6 GiB
      expect(estimateBufferPool(100_000_000)).toBe(Math.floor(0.8 * 32 * GiB));
    } finally {
      totalmemSpy.mockRestore();
    }
  });

  it('an undetectable page size behaves exactly like 4 KiB (ratio 1)', () => {
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
    try {
      _setOsPageSizeForTests(null);
      expect(estimateBufferPool(100_000)).toBe(100_000 * 4 * 1024);
    } finally {
      totalmemSpy.mockRestore();
    }
  });

  it('the hintless default passed to the Database ctor stays at the unscaled #2557 cap on 64 KiB hosts', () => {
    // The guard for the #2557 OOM protection: MCP serve / doctor / any open
    // without a per-run hint must NOT inherit the page-size-scaled budget —
    // the pool is an eager allocation at DB open.
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
    try {
      _setOsPageSizeForTests(65536);
      const Database = vi.fn(function (this: any) {});
      createLbugDatabase({ Database } as any, '/tmp/lbug-pool-64k');
      expect(bufferPoolArg(Database)).toBe(2 * GiB);
    } finally {
      totalmemSpy.mockRestore();
    }
  });

  it('the analyze hint path DOES scale on 64 KiB hosts (scaled floor, bounded by 80% RAM)', () => {
    const totalmemSpy = vi.spyOn(os, 'totalmem').mockReturnValue(32 * GiB);
    try {
      _setOsPageSizeForTests(65536);
      setBufferPoolSizeHint(estimateBufferPool(41));
      const Database = vi.fn(function (this: any) {});
      createLbugDatabase({ Database } as any, '/tmp/lbug-pool-64k-hint');
      // 41 elements → below the scaled COPY floor → 16 × 256 MiB = 4 GiB
      expect(bufferPoolArg(Database)).toBe(16 * 256 * MiB);
    } finally {
      totalmemSpy.mockRestore();
    }
  });

  it('GITNEXUS_LBUG_BUFFER_POOL_SIZE stays absolute on 64 KiB hosts (incl. 0 = native default)', () => {
    _setOsPageSizeForTests(65536);
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', String(512 * MiB));
    const Database = vi.fn(function (this: any) {});
    createLbugDatabase({ Database } as any, '/tmp/lbug-pool-64k-env');
    expect(bufferPoolArg(Database)).toBe(512 * MiB);
  });
});

// ─── #2631: actionable pool-exhaustion remedy ───────────────────────────────
describe('bufferPoolExhaustionRemedy (#2631)', () => {
  afterEach(() => _setOsPageSizeForTests(undefined));

  const EXHAUSTION =
    'Buffer manager exception: Unable to allocate memory! The buffer pool is full and no memory could be freed!';

  it('names the override knob for the exhaustion error', () => {
    _setOsPageSizeForTests(4096);
    const remedy = bufferPoolExhaustionRemedy(EXHAUSTION);
    expect(remedy).toContain('GITNEXUS_LBUG_BUFFER_POOL_SIZE');
    expect(remedy).toContain('buffer pool');
    // ratio 1 → no page-size amplification note
    expect(remedy).not.toContain('OS page size');
  });

  it('explains the granule amplification on a 64 KiB-page host', () => {
    _setOsPageSizeForTests(65536);
    const remedy = bufferPoolExhaustionRemedy(EXHAUSTION);
    expect(remedy).toContain('64 KiB OS page size');
    expect(remedy).toContain('16×');
    expect(remedy).toContain('GITNEXUS_LBUG_BUFFER_POOL_SIZE');
  });

  it('is silent for non-exhaustion errors', () => {
    _setOsPageSizeForTests(65536);
    expect(
      bufferPoolExhaustionRemedy('Binder exception: Table CodeEmbedding does not exist.'),
    ).toBeUndefined();
  });

  it('labels the 0 sentinel as the native default instead of "0 MiB"', () => {
    _setOsPageSizeForTests(4096);
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', '0');
    try {
      const remedy = bufferPoolExhaustionRemedy(EXHAUSTION);
      expect(remedy).toContain('native 80%-of-RAM default');
      expect(remedy).not.toContain('(0 MiB)');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
