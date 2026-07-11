import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import {
  _resetOsPageSizeCacheForTest,
  getOsPageSize,
  isLbugPageSizeFrameError,
  isPageSizeAwareLadybug,
} from '../../src/core/lbug/lbug-config.js';

// Pass-through spy on the bare 'child_process' specifier (lbug-config.ts
// imports execFileSync from 'child_process', not 'node:child_process').
// Real behavior is preserved by default, so the live-probe test below still
// exercises the host getconf — including the real 16 KiB pages on the
// macos-arm64 CI matrix — while failure-path tests override single calls via
// mockImplementationOnce. Recipe: sibling-clone-drift.test.ts.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const execFileSyncSpy = vi.mocked(execFileSync);

// getOsPageSize short-circuits before any exec on win32, so every
// exec-asserting test below is POSIX-only (skipIf pairs, no if-branching).
const onWindows = process.platform === 'win32';

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
    execFileSyncSpy.mockClear();
  });

  it.skipIf(onWindows)('returns a positive power-of-two page size on POSIX platforms', () => {
    const pageSize = getOsPageSize();
    expect(pageSize).toBeDefined();
    expect(Number.isInteger(pageSize)).toBe(true);
    // Every real page size is a power of two (4K, 16K, 64K, ...). log2 of a
    // power of two is an integer; `?? 0` narrows without a cast or branch and
    // Math.log2(0) is -Infinity, which fails isInteger.
    expect(Number.isInteger(Math.log2(pageSize ?? 0))).toBe(true);
  });

  it.skipIf(!onWindows)('returns undefined on Windows without forking', () => {
    expect(getOsPageSize()).toBeUndefined();
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });

  it.skipIf(onWindows)('returns undefined when the probe cannot exec', () => {
    execFileSyncSpy.mockImplementationOnce(() => {
      throw new Error('spawnSync getconf ENOENT');
    });
    expect(getOsPageSize()).toBeUndefined();
  });

  it.skipIf(onWindows)('returns undefined on non-numeric probe output', () => {
    execFileSyncSpy.mockImplementationOnce(() => 'unlimited');
    expect(getOsPageSize()).toBeUndefined();
  });

  it.skipIf(onWindows)('returns undefined on empty probe output', () => {
    execFileSyncSpy.mockImplementationOnce(() => '');
    expect(getOsPageSize()).toBeUndefined();
  });

  it.skipIf(onWindows)('execs getconf with a SIGKILL-hardened 2s timeout', () => {
    getOsPageSize();
    expect(execFileSyncSpy).toHaveBeenCalledWith(
      'getconf',
      ['PAGE_SIZE'],
      expect.objectContaining({ timeout: 2000, killSignal: 'SIGKILL' }),
    );
  });

  it.skipIf(onWindows)('returns undefined when the probe times out', () => {
    // execFileSync's timeout kill surfaces as a throw with `signal` set and
    // `status` null — the fail-safe must hold for the kill path too.
    execFileSyncSpy.mockImplementationOnce(() => {
      const err = new Error('spawnSync getconf ETIMEDOUT') as Error & {
        signal: string;
        status: null;
      };
      err.signal = 'SIGKILL';
      err.status = null;
      throw err;
    });
    expect(getOsPageSize()).toBeUndefined();
  });

  it.skipIf(onWindows)('probes at most once per process (cached)', () => {
    expect(getOsPageSize()).toBe(getOsPageSize());
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
    _resetOsPageSizeCacheForTest();
    getOsPageSize();
    expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
  });
});
