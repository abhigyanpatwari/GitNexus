/**
 * Coverage for `resolveGoPackage` (`import-resolvers/go.ts`), which had none.
 *
 * Go resolves package imports through two independent legs. The ScopeResolver
 * leg (`languages/go/import-target.ts`) answers from `buildPackageDirIndex`;
 * this one is the LanguageProvider leg, wired through `configs/go.ts`, and it
 * is still a per-import scan. #2881 changed its membership rule — a directory
 * whose name repeats higher in the path is now a member — and review found the
 * change reached production with nothing watching it: `bench/import-target`'s
 * go arm drives the indexed leg only, and no test called this function.
 *
 * These cases pin the rule and the two legs' agreement on it, so a revert fails
 * here rather than silently moving Go IMPORTS edges in every repository that
 * nests a package name inside itself (`internal/…/internal` is the shape Go
 * actually produces).
 *
 * One caveat on "the LanguageProvider leg", recorded in #2929 review: nothing
 * in production reads that field today. `configs/go.ts` reaches this function
 * through `createImportResolver` → `LanguageProvider.importResolver`, and the
 * only readers of `importResolver` are `import-target-adapter.ts:74-75`, whose
 * two exports have no importer outside their own unit test. So the leg is wired
 * but unreached, and this file is the only thing exercising it.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveGoPackage,
  resolveGoPackageDir,
} from '../../../src/core/ingestion/import-resolvers/go.js';
import type { GoModuleConfig } from '../../../src/core/ingestion/language-config.js';
import { resolveGoImportTarget } from '../../../src/core/ingestion/languages/go/import-target.js';

const MOD: GoModuleConfig = { modulePath: 'example.com/mod' };

function resolve(files: readonly string[], importPath: string): string[] {
  const normalized = files.map((f) => f.replace(/\\/g, '/'));
  return resolveGoPackage(importPath, MOD, normalized, files);
}

/** The indexed leg, for the agreement arm. */
function indexed(files: readonly string[], importPath: string): readonly string[] {
  const got = resolveGoImportTarget(importPath, 'main.go', new Set(files), MOD);
  // `typeof got === 'string'`, not `Array.isArray(got)`: `Array.isArray` narrows
  // to `any[]`, which does not subsume `readonly string[]`, so the false branch
  // kept the array member and `[got]` did not typecheck (TS2322 under
  // `tsconfig.test.json`). Runtime behaviour is identical.
  return got === null ? [] : typeof got === 'string' ? [got] : got;
}

describe('resolveGoPackage', () => {
  it('returns every .go file directly inside the package directory', () => {
    const files = ['internal/auth/service.go', 'internal/auth/token.go', 'internal/auth/sub/x.go'];
    expect(resolve(files, 'example.com/mod/internal/auth')).toEqual([
      'internal/auth/service.go',
      'internal/auth/token.go',
    ]);
  });

  it('a package directory nested inside a same-named one IS a member (#2881)', () => {
    // The scan asked `indexOf` for the FIRST `/pkg/` and then required nothing
    // after it to hold a slash, so this resolved to nothing. Both halves of the
    // shape: the repeat leading the path, and the repeat mid-path.
    expect(resolve(['pkg/src/go/pkg/repo.go'], 'example.com/mod/pkg')).toEqual([
      'pkg/src/go/pkg/repo.go',
    ]);
    expect(resolve(['a/pkg/b/pkg/x.go'], 'example.com/mod/pkg')).toEqual(['a/pkg/b/pkg/x.go']);
    expect(resolve(['svc/internal/sub/internal/x.go'], 'example.com/mod/internal')).toEqual([
      'svc/internal/sub/internal/x.go',
    ]);
  });

  it('a repeated name that is not the parent directory is still not a member', () => {
    // The rule is "the parent directory ends with the package path", not
    // "the package path appears anywhere".
    expect(resolve(['a/pkg/b/x.go'], 'example.com/mod/pkg')).toEqual([]);
    expect(resolve(['internal/auth/sub/x.go'], 'example.com/mod/internal/auth')).toEqual([]);
  });

  it('multi-segment package paths match on the whole run, not the last segment', () => {
    const files = ['a/internal/models/b/internal/models/user.go', 'a/models/other.go'];
    expect(resolve(files, 'example.com/mod/internal/models')).toEqual([
      'a/internal/models/b/internal/models/user.go',
    ]);
  });

  it('_test.go files are a different package and never match', () => {
    expect(
      resolve(
        ['internal/auth/service.go', 'internal/auth/service_test.go'],
        'example.com/mod/internal/auth',
      ),
    ).toEqual(['internal/auth/service.go']);
  });

  it('non-.go files never match, and the RAW path is returned for backslashes', () => {
    expect(
      resolve(['internal/auth/README.md', 'internal/auth/x.go'], 'example.com/mod/internal/auth'),
    ).toEqual(['internal/auth/x.go']);
    expect(resolve(['internal\\auth\\x.go'], 'example.com/mod/internal/auth')).toEqual([
      'internal\\auth\\x.go',
    ]);
  });

  it('an import outside the module, or the module root itself, resolves to nothing here', () => {
    expect(resolve(['internal/auth/x.go'], 'github.com/other/repo/internal/auth')).toEqual([]);
    // The root package is the caller's `findRootPackageFiles` leg, not this one.
    expect(resolve(['main.go'], 'example.com/mod')).toEqual([]);
    expect(resolveGoPackageDir('example.com/mod', MOD)).toBeNull();
    expect(resolveGoPackageDir('example.com/mod/internal/auth', MOD)).toBe('/internal/auth/');
  });

  it('vendor/, testdata/ and nested-module directories all merge in (unmodelled)', () => {
    // Go excludes all three from a package: `vendor/` is a dependency tree
    // resolved against the vendoring module, the go tool ignores `testdata/`
    // entirely, and a directory carrying its own `go.mod` is a separate module
    // whose packages this module's import paths never name.
    //
    // This resolver models NONE of that — it matches on the parent directory's
    // path suffix alone. That is unchanged by #2881: the pre-#2881 rule
    // (first `/<pkg>/`, nothing but a filename after it) accepted all three
    // shapes too. These assertions record what the function actually does so
    // the gap is visible and a change to it is deliberate; they document the
    // behaviour rather than endorse it.
    const files = [
      'go.mod',
      'internal/auth/service.go',
      'vendor/example.com/dep/internal/auth/vendored.go',
      'testdata/internal/auth/fixture.go',
      'sub/go.mod', // `sub/` is its own module; its packages are not ours
      'sub/internal/auth/other_module.go',
    ];
    expect(resolve(files, 'example.com/mod/internal/auth')).toEqual([
      'internal/auth/service.go',
      'vendor/example.com/dep/internal/auth/vendored.go',
      'testdata/internal/auth/fixture.go',
      'sub/internal/auth/other_module.go',
    ]);
    // A `go.mod` beside the files changes nothing — it is not read here.
    expect(resolve(['sub/go.mod', 'sub/pkg/x.go'], 'example.com/mod/pkg')).toEqual([
      'sub/pkg/x.go',
    ]);
  });

  it('agrees with the indexed leg on the repeated-name shapes', () => {
    // The two legs are independent implementations of one rule. Before #2881
    // they agreed on the wrong answer; they must agree on the right one, or
    // Go's LanguageProvider and ScopeResolver hooks disagree about which files
    // a package holds.
    for (const files of [
      ['pkg/src/go/pkg/repo.go'],
      ['a/pkg/b/pkg/x.go'],
      ['a/pkg/b/x.go'],
      ['internal/auth/service.go', 'internal/auth/token.go'],
      ['a/internal/models/b/internal/models/user.go'],
    ]) {
      for (const target of [
        'example.com/mod/pkg',
        'example.com/mod/internal/auth',
        'example.com/mod/internal/models',
      ]) {
        expect(resolve(files, target)).toEqual([...indexed(files, target)]);
      }
    }
  });
});
