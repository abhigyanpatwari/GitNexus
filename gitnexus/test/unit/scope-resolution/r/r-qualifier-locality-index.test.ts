/**
 * `rQualifierLocality` is asked about every distinct `pkg::` qualifier of a run. Answering each
 * from a scan of every file path is qualifiers x files (4,000 x 5,000 took 0.84 s); an index of the
 * `<name>/R/` directory names, built once, makes it linear. The index must give the same answers.
 */
import { describe, expect, it } from 'vitest';
import type { RPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';
import {
  rQualifierLocality,
  rUnownedPackageDirNames,
} from '../../../../src/core/ingestion/languages/r/qualified-call.js';

const config = (packages: Record<string, string>, truncated = false): RPackageConfig => ({
  packages: new Map(Object.entries(packages)),
  namespaceInfoByPackageDir: new Map(),
  truncated,
});

/** A set of paths that counts every way of walking all of them. */
class CountingSet extends Set<string> {
  walks = 0;
  override [Symbol.iterator](): SetIterator<string> {
    this.walks++;
    return super[Symbol.iterator]();
  }
  override values(): SetIterator<string> {
    this.walks++;
    return super.values();
  }
}

describe('rUnownedPackageDirNames', () => {
  const cfg = config({ owner: 'pkgs/owner' });

  it('lists the directories that precede R/ in a path no discovered package owns', () => {
    expect(
      [
        ...rUnownedPackageDirNames(
          ['foo/R/a.R', 'deep/x/bar/R/b.R', 'scripts/a.R', 'R/top.R', 'baz\\R\\c.R', 'foo/R'],
          cfg,
        ),
      ].sort(),
    ).toEqual(['bar', 'baz', 'foo']);
  });

  it('leaves out the directory of a file a discovered package owns', () => {
    expect([...rUnownedPackageDirNames(['pkgs/owner/R/a.R', 'other/R/b.R'], cfg)]).toEqual([
      'other',
    ]);
  });
});

describe('rQualifierLocality with the index', () => {
  const cfg = config({ known: 'pkgs/known', owner: 'pkgs/owner' });
  const paths = new Set([
    'pkgs/known/R/a.R',
    'pkgs/owner/R/b.R',
    'extra/R/c.R',
    'deep/x/nested/R/d.R',
    'scripts/e.R',
  ]);

  it.each(['known', 'owner', 'extra', 'nested', 'x', 'scripts', 'R', 'missing', 'pkgs', 'deep'])(
    'answers %s as the scan does',
    (pkg) => {
      for (const c of [cfg, config({}, true), null]) {
        const index = rUnownedPackageDirNames(paths, c);
        expect(rQualifierLocality(pkg, c, paths, index)).toBe(rQualifierLocality(pkg, c, paths));
      }
    },
  );

  it('never walks the file paths once the index is given', () => {
    const counted = new CountingSet(paths);
    const index = rUnownedPackageDirNames(paths, cfg);
    for (let i = 0; i < 1_000; i++) rQualifierLocality(`pkg${String(i)}`, cfg, counted, index);
    expect(rQualifierLocality('extra', cfg, counted, index)).toBe('local');
    expect(counted.walks).toBe(0);
  });

  it('walks them for every qualifier without it (the cost the index removes)', () => {
    const counted = new CountingSet(paths);
    for (let i = 0; i < 10; i++) rQualifierLocality(`pkg${String(i)}`, cfg, counted);
    expect(counted.walks).toBe(10);
  });
});
