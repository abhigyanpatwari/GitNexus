/**
 * #2668 path-normalization guard — split out of `analyzer-identity.test.ts` so it
 * can run on the Windows/macOS matrix.
 *
 * `normalizeAnalyzerRootPath` is a POSIX no-op, so these assertions only bite on
 * windows-latest; the file is registered in `scripts/cross-platform-tests.ts` for
 * exactly that reason. It is deliberately separate from `analyzer-identity.test.ts`,
 * and holds ONLY pure-function assertions that pass an explicit `platform` argument
 * — no fixture, no filesystem. That restriction is load-bearing: the fixture-based
 * identity tests cannot run on this matrix, for two independent reasons observed in
 * CI on this PR —
 *   - macOS: they compare identity fields against the raw temp-dir path while the
 *     identity realpaths it, so `/var/...` comes back as `/private/var/...`;
 *   - Windows: the GH runner puts the repo on `D:` and temp fixtures on `C:`, and
 *     `isInside()` misjudges cross-drive paths (`path.win32.relative` returns the
 *     absolute target, which does not start with `..`), so `resolveInvokedArtifact`
 *     picks the vitest fork worker and identity resolution throws.
 * Keep this file fixture-free so it stays green on every runner.
 */
import { describe, it, expect } from 'vitest';
import { normalizeAnalyzerRootPath } from '../../src/core/analyzer-identity.js';

// #2668: `status` reported a freshly-analyzed, untouched repo as stale on
// Windows because `build.rootPath` (and the other compared identity path
// fields) carried the drive-letter case that `realpathSync.native` did not
// normalize — so `analyze` and `status`, launched under different casing,
// stamped vs recomputed unequal identities. `normalizeAnalyzerRootPath`
// collapses that variance at the single upstream source (resolveBuildRoot).
describe('normalizeAnalyzerRootPath (#2668)', () => {
  it('uppercases a Windows drive letter so case-variant roots collapse', () => {
    expect(normalizeAnalyzerRootPath('c:\\gitnexus\\dist', 'win32')).toBe('C:\\gitnexus\\dist');
    expect(normalizeAnalyzerRootPath('c:\\gitnexus\\dist', 'win32')).toBe(
      normalizeAnalyzerRootPath('C:\\gitnexus\\dist', 'win32'),
    );
    // Forward-slash drive form (as some resolvers emit) is normalized too.
    expect(normalizeAnalyzerRootPath('d:/build', 'win32')).toBe('D:/build');
  });

  it('is idempotent and leaves an already-uppercase drive unchanged', () => {
    expect(normalizeAnalyzerRootPath('C:\\build', 'win32')).toBe('C:\\build');
    expect(
      normalizeAnalyzerRootPath(normalizeAnalyzerRootPath('c:\\build', 'win32'), 'win32'),
    ).toBe('C:\\build');
  });

  it('only touches a leading drive letter, not other path bytes', () => {
    // A UNC path has no drive letter; interior case is preserved.
    expect(normalizeAnalyzerRootPath('\\\\server\\Share\\Repo', 'win32')).toBe(
      '\\\\server\\Share\\Repo',
    );
    expect(normalizeAnalyzerRootPath('C:\\Repo\\subDir', 'win32')).toBe('C:\\Repo\\subDir');
  });

  it('normalizes the drive under an extended-length \\\\?\\ prefix, preserving the prefix', () => {
    expect(normalizeAnalyzerRootPath('\\\\?\\c:\\gitnexus\\dist', 'win32')).toBe(
      '\\\\?\\C:\\gitnexus\\dist',
    );
    // Extended UNC form has no drive letter — left untouched.
    expect(normalizeAnalyzerRootPath('\\\\?\\UNC\\server\\Share', 'win32')).toBe(
      '\\\\?\\UNC\\server\\Share',
    );
  });

  it('is a no-op on POSIX (case-sensitive paths must not be mutated)', () => {
    expect(normalizeAnalyzerRootPath('/home/user/gitnexus/dist', 'linux')).toBe(
      '/home/user/gitnexus/dist',
    );
    expect(normalizeAnalyzerRootPath('/Home/User/Dist', 'darwin')).toBe('/Home/User/Dist');
  });
});
