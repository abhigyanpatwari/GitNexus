/**
 * #2668 path-normalization guard — split out of `analyzer-identity.test.ts` so it
 * can run on the Windows/macOS matrix.
 *
 * `normalizeAnalyzerRootPath` is a POSIX no-op, so these assertions only bite on
 * windows-latest; the file is registered in `scripts/cross-platform-tests.ts` for
 * exactly that reason. It is deliberately separate from `analyzer-identity.test.ts`,
 * whose fixture-based tests compare identity fields against raw temp-dir paths and
 * are therefore not portable to macOS (where `/var/...` realpaths to `/private/var/...`).
 * Everything here is either a pure-function assertion with an explicit `platform`
 * argument, or a self-referential fixpoint check — both portable to every runner.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizeAnalyzerRootPath,
  resolveAnalyzerRunnerIdentity,
} from '../../src/core/analyzer-identity.js';
import { createTempDir } from '../helpers/test-db.js';

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

  // #2668 threading guard: the produced identity's path fields must already be
  // normalizer-stable, i.e. resolveBuildRoot/resolveRuntimeVariant actually route
  // build.rootPath and runtime.executablePath through normalizeAnalyzerRootPath.
  // On POSIX the normalizer is a no-op, so this is a trivially-true fixpoint here
  // and a real regression guard on Windows CI (where an un-threaded call site
  // would leave a lowercase drive that the normalizer would change). It compares
  // each field against ITSELF normalized — never against the raw fixture path —
  // so it is immune to the macOS /var → /private/var realpath difference.
  it('produces identity path fields that are already normalizer-stable', async () => {
    const fixture = await createTempDir();
    try {
      const sourceRoot = path.join(fixture.dbPath, 'src');
      const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
      await mkdir(path.dirname(modulePath), { recursive: true });
      await writeFile(
        path.join(fixture.dbPath, 'package.json'),
        '{"name":"fixture-analyzer","version":"1.0.0"}\n',
      );
      await writeFile(path.join(fixture.dbPath, 'package-lock.json'), '{"lockfileVersion":3}\n');
      await writeFile(modulePath, 'export const analyzer = 1;\n');

      const identity = resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
        cacheDirectory: path.join(fixture.dbPath, 'identity-cache'),
      });

      expect(identity.build.rootPath).toBe(
        normalizeAnalyzerRootPath(identity.build.rootPath, process.platform),
      );
      expect(identity.runtime.executablePath).toBe(
        normalizeAnalyzerRootPath(identity.runtime.executablePath, process.platform),
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
