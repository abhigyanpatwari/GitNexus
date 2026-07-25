/**
 * #2667 — the Windows extended-length (`\\?\`) prefix must never survive into a
 * path GitNexus compares or keys on.
 *
 * `stripWindowsLongPathPrefix` is a POSIX no-op, so these assertions only bite on
 * windows-latest; the file is registered in `scripts/cross-platform-tests.ts` for
 * exactly that reason. Like `analyzer-identity-path-normalization.test.ts`, it holds
 * ONLY pure-function assertions with an explicit `platform` argument — no fixture,
 * no filesystem — so it stays green on every runner.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { stripWindowsLongPathPrefix } from '../../src/lib/utils.js';

describe('stripWindowsLongPathPrefix (#2667)', () => {
  it('strips the prefix from a drive path', () => {
    expect(stripWindowsLongPathPrefix('\\\\?\\D:\\Projects\\repo', 'win32')).toBe(
      'D:\\Projects\\repo',
    );
  });

  it('rewrites the UNC form back to its `\\\\server\\share` shape', () => {
    expect(stripWindowsLongPathPrefix('\\\\?\\UNC\\server\\share\\repo', 'win32')).toBe(
      '\\\\server\\share\\repo',
    );
  });

  it('leaves a volume-GUID path untouched — its remainder is not a usable path', () => {
    expect(stripWindowsLongPathPrefix('\\\\?\\Volume{1a2b3c4d}\\repo', 'win32')).toBe(
      '\\\\?\\Volume{1a2b3c4d}\\repo',
    );
  });

  it('is a no-op on already-canonical drive and UNC paths', () => {
    expect(stripWindowsLongPathPrefix('D:\\Projects\\repo', 'win32')).toBe('D:\\Projects\\repo');
    expect(stripWindowsLongPathPrefix('\\\\server\\share\\repo', 'win32')).toBe(
      '\\\\server\\share\\repo',
    );
  });

  it('is idempotent — it runs wherever a comparison key is built', () => {
    const once = stripWindowsLongPathPrefix('\\\\?\\D:\\Projects\\repo', 'win32');
    expect(stripWindowsLongPathPrefix(once, 'win32')).toBe(once);

    const uncOnce = stripWindowsLongPathPrefix('\\\\?\\UNC\\server\\share\\repo', 'win32');
    expect(stripWindowsLongPathPrefix(uncOnce, 'win32')).toBe(uncOnce);
  });

  it('is a no-op off Windows, where `\\\\?\\…` is an ordinary filename', () => {
    expect(stripWindowsLongPathPrefix('\\\\?\\D:\\repo', 'linux')).toBe('\\\\?\\D:\\repo');
    expect(stripWindowsLongPathPrefix('/home/node/repo', 'linux')).toBe('/home/node/repo');
  });

  // The leak this normalization exists to prevent. `path.win32.relative` cannot
  // express a relative path between a prefixed and an un-prefixed form of the SAME
  // directory — they share no root — so it returns the absolute target instead.
  // That absolute string is exactly what #2667 reported inside node IDs
  // (`Function:\\?\D:\…\market.move:…`), and it is the same defect class as the
  // cross-drive `isInside` bug fixed in #2688.
  it('makes a mixed-prefix relativization relative again', () => {
    const prefixed = '\\\\?\\D:\\repo';
    const child = 'D:\\repo\\a\\b.move';

    expect(path.win32.relative(prefixed, child)).toBe(child);
    expect(path.win32.relative(stripWindowsLongPathPrefix(prefixed, 'win32'), child)).toBe(
      'a\\b.move',
    );
  });
});
