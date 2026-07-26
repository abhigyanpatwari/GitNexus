/**
 * #2667 — a `\\?\`-prefixed path must still find its registry entry.
 *
 * This is the Linux-runnable guard for the `canonicalizePath` wiring. The
 * companion assertions in `repo-manager.test.ts` exercise the real
 * `realpathSync.native` and are therefore `it.skipIf(win32)`, so they only run on
 * the windows-latest matrix leg — leaving the Ubuntu gate with no coverage of the
 * behaviour at all. This file closes that hole by injecting the two platform
 * primitives and nothing else:
 *
 *   - `path` → `path.win32`, which is Node's real Windows path implementation,
 *     not a stand-in for it;
 *   - `realpathSync.native` → its two actual Windows behaviours: for a path that
 *     is on disk libuv's `fs__realpath_handle` strips `\\?\` before returning,
 *     and for a path that is not it throws ENOENT;
 *   - `stripWindowsLongPathPrefix` → the real implementation, pinned to `'win32'`
 *     instead of defaulting to `process.platform`.
 *
 * That last one is deliberately a module mock rather than an
 * `Object.defineProperty(process, 'platform', …)`: module mocks are scoped to this
 * file, whereas `process` is shared by every test file in the same worker, so
 * overriding it risks a sibling that branches on the host platform.
 *
 * `canonicalizePath` and `registryPathEquals` themselves run unmodified. Run
 * against the pre-fix tree (89bbdcf5) the two `catch`-fallback cases below fail
 * and the realpath case passes, which is exactly the asymmetry the fix targets:
 * the realpath branch never leaked, because libuv strips the prefix itself.
 *
 * Deliberately NOT registered in `scripts/cross-platform-tests.ts`: it simulates
 * Windows rather than needing it, so its home is the Ubuntu suite.
 */
import { describe, it, expect, vi } from 'vitest';

// `vi.mock` factories are hoisted above imports, so the set of "paths that exist
// on disk" has to be hoisted with them rather than captured from module scope.
const onDisk = vi.hoisted(() => new Set<string>());

vi.mock('path', async () => {
  const real = await vi.importActual<typeof import('path')>('path');
  return { ...real.win32, default: real.win32 };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realpath = (target: string): string => {
    const bare = String(target).replace(/^\\\\\?\\(UNC\\)?/, (_m, unc) => (unc ? '\\\\' : ''));
    if (!onDisk.has(bare)) {
      const err: NodeJS.ErrnoException = new Error(
        `ENOENT: no such file or directory, realpath '${target}'`,
      );
      err.code = 'ENOENT';
      throw err;
    }
    return bare;
  };
  const realpathSync = Object.assign(realpath, { native: realpath });
  return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});

// The real helper, pinned to win32 — `canonicalizePath` calls it without a
// platform argument, so it would otherwise default to the host's.
vi.mock('../../src/lib/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/utils.js')>();
  return {
    ...actual,
    stripWindowsLongPathPrefix: (p: string) => actual.stripWindowsLongPathPrefix(p, 'win32'),
  };
});

import { canonicalizePath, registryPathEquals } from '../../src/storage/repo-manager.js';

/**
 * The lookup every registry consumer performs — `resolveRegistryEntry`,
 * `registerRepo`, `unregisterRepo`, `isRepoRegistered`, `cloneDirBelongsToEntry`,
 * the MCP handle match and the server repo routes all canonicalise both sides and
 * compare with `registryPathEquals`.
 */
const registryLookupMatches = (stored: string, supplied: string): boolean =>
  registryPathEquals(canonicalizePath(stored), canonicalizePath(supplied));

describe('canonicalizePath vs the `\\\\?\\` long-path prefix (#2667)', () => {
  it('matches a prefixed drive path against its stored entry when the repo is gone from disk', () => {
    const stored = 'D:\\Projects\\moved-away';

    // The `catch` fallback: realpath throws, so pre-fix this returned
    // `path.resolve(p)` with the prefix still attached and matched nothing.
    expect(canonicalizePath(`\\\\?\\${stored}`)).toBe(stored);
    expect(registryLookupMatches(stored, `\\\\?\\${stored}`)).toBe(true);
  });

  it('matches a prefixed UNC path against its stored entry when the share is unreachable', () => {
    const stored = '\\\\server\\share\\moved-away';

    expect(canonicalizePath('\\\\?\\UNC\\server\\share\\moved-away')).toBe(stored);
    expect(registryLookupMatches(stored, '\\\\?\\UNC\\server\\share\\moved-away')).toBe(true);
  });

  it('matches whatever case the UNC token is spelled in', () => {
    const stored = '\\\\server\\share\\moved-away';

    expect(registryLookupMatches(stored, '\\\\?\\unc\\server\\share\\moved-away')).toBe(true);
    expect(registryLookupMatches(stored, '\\\\?\\Unc\\server\\share\\moved-away')).toBe(true);
  });

  it('still matches through the realpath branch when the repo is present on disk', () => {
    const stored = 'D:\\Projects\\present';
    onDisk.add(stored);

    // This branch never leaked — libuv strips the prefix inside fs__realpath — so
    // it passes on the pre-fix tree too. It is here so a future change that moves
    // the normalisation cannot silently break the path that always worked.
    expect(canonicalizePath(`\\\\?\\${stored}`)).toBe(stored);
    expect(registryLookupMatches(stored, `\\\\?\\${stored}`)).toBe(true);
  });

  it('leaves an un-prefixed path byte-identical, on both branches', () => {
    const present = 'D:\\Projects\\present';
    onDisk.add(present);

    expect(canonicalizePath(present)).toBe(present);
    expect(canonicalizePath('D:\\Projects\\absent')).toBe('D:\\Projects\\absent');
  });
});
