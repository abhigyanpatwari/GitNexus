import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetOsPageSizeCacheForTest,
  getOsPageSize,
  isLbugPageSizeFrameError,
  isPageSizeAwareLadybug,
} from '../../src/core/lbug/lbug-config.js';

// ─── #1231: non-4K page-size frame-release matcher ──────────────────────────

describe('isLbugPageSizeFrameError', () => {
  it.each([
    [
      'exact Raspberry Pi 5 failure (issue #1231)',
      'Buffer manager exception: Releasing physical memory associated with a frame failed with error code -1: Invalid argument.',
    ],
    [
      'wrapped by the node-COPY error path',
      'COPY failed for File: Buffer manager exception: Releasing physical memory associated with a frame failed with error code -1: Invalid argument.',
    ],
    [
      '0.18.0 residual guard',
      'Buffer manager exception: Unsupported page size combination: frame size 4096, discard granule size 65536, frame group size 16384.',
    ],
  ])('matches %s', (_label, msg) => {
    expect(isLbugPageSizeFrameError(msg)).toBe(true);
    expect(isLbugPageSizeFrameError(new Error(msg))).toBe(true);
  });

  it.each([
    [
      'buffer pool exhaustion (a sizing problem, not page size)',
      'Buffer manager exception: Unable to allocate memory! The buffer pool is full and no memory could be freed!',
    ],
    ['8TB mmap failure (#785)', 'Buffer manager exception: Mmap for size 8796093022208 failed.'],
    ['WAL corruption', 'Runtime exception: Corrupted wal file. Read out invalid WAL record type.'],
    ['lock contention', 'Could not set lock on file : /path/to/db'],
    ['generic', 'Query failed'],
  ])('does NOT match %s', (_label, msg) => {
    expect(isLbugPageSizeFrameError(msg)).toBe(false);
  });

  it('handles non-string input', () => {
    expect(isLbugPageSizeFrameError(undefined)).toBe(false);
    expect(isLbugPageSizeFrameError(null)).toBe(false);
    expect(isLbugPageSizeFrameError(42)).toBe(false);
  });
});

// ─── #1231: page-size-aware LadybugDB version gate ──────────────────────────

describe('isPageSizeAwareLadybug', () => {
  it.each([
    ['0.18.0', true],
    ['0.18.0-dev.20260708', true],
    ['0.19.2', true],
    ['1.0.0', true],
    ['0.17.1', false],
    ['0.16.0', false],
    ['0.15.4', false],
  ])('%s -> %s', (version, expected) => {
    expect(isPageSizeAwareLadybug(version)).toBe(expected);
  });

  it('returns false for unknown/unparseable versions (err on showing the upgrade hint)', () => {
    expect(isPageSizeAwareLadybug(undefined)).toBe(false);
    expect(isPageSizeAwareLadybug('')).toBe(false);
    expect(isPageSizeAwareLadybug('unknown')).toBe(false);
    expect(isPageSizeAwareLadybug('v0.18.0')).toBe(false);
  });
});

// ─── #1231: OS page-size probe ───────────────────────────────────────────────

describe('getOsPageSize', () => {
  afterEach(() => {
    _resetOsPageSizeCacheForTest();
  });

  it('returns a positive power-of-two page size on POSIX platforms', () => {
    const pageSize = getOsPageSize();
    if (process.platform === 'win32') {
      expect(pageSize).toBeUndefined();
    } else {
      expect(pageSize).toBeGreaterThan(0);
      expect(Number.isInteger(pageSize)).toBe(true);
      // Every real page size is a power of two (4K, 16K, 64K, ...).
      expect(((pageSize as number) & ((pageSize as number) - 1)) === 0).toBe(true);
    }
  });

  it('caches the probe (two calls return the identical value)', () => {
    expect(getOsPageSize()).toBe(getOsPageSize());
  });
});
