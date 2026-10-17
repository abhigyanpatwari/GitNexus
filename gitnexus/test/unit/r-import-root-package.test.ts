import { describe, it, expect } from 'vitest';
import { resolveRImportTarget } from '../../src/core/ingestion/import-resolvers/r.js';
import type { RPackageConfig } from '../../src/core/ingestion/languages/r/package-config.js';

// `library("pkg")` resolves to the `R/` files of the local package, whatever directory the
// package lives in; a root-level package has the directory '' and must not be skipped for it.
const wildcard = { parsedImport: { kind: 'wildcard' } } as never;

const config = (dir: string): RPackageConfig => ({
  packages: new Map([['mypkg', dir]]),
  namespaceInfoByPackageDir: new Map(),
});

const resolve = (dir: string, files: string[]): readonly string[] | string | null =>
  resolveRImportTarget('mypkg', 'scripts/use.R', new Set(files), config(dir), wildcard);

describe('resolveRImportTarget: library() of a local package', () => {
  it('resolves a root-level package to its R/ files only', () => {
    const out = resolve('', ['R/a.R', 'R/b.r', 'scripts/use.R', 'tests/testthat/t.R', 'inst/x.R']);
    expect([...(out as string[])].sort()).toEqual(['R/a.R', 'R/b.r']);
  });

  it('resolves a nested package to its R/ files only', () => {
    const out = resolve('pkgs/mypkg', [
      'pkgs/mypkg/R/a.R',
      'pkgs/mypkg/tests/t.R',
      'R/other.R',
      'scripts/use.R',
    ]);
    expect(out).toEqual(['pkgs/mypkg/R/a.R']);
  });
});
