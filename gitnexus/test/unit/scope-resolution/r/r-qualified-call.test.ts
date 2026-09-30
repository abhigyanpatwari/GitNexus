/**
 * R qualified-call helpers (fork #7, plan step 3):
 *
 *  - `parseRQualifier(raw)`: the package named by a `@reference.qualified-name` text;
 *  - `rQualifierLocality(pkg, cfg, filePaths)`: `local` | `external` | `unknown`;
 *  - `RPackageConfig.truncated`: set by `loadRPackageConfig` when its depth-3 / 200-directory
 *    walk stopped with directories unvisited.
 *
 * The helpers live in `languages/r/qualified-call.ts`, which does not exist at this commit.
 * Decision: the helper tests are `it.fails`, importing the module through a non-literal
 * dynamic specifier. Today the import rejects, so each test fails and `it.fails` passes; at
 * step 3 the module exists, the tests pass, `it.fails` turns red, and that forces the flip to
 * `it`. (`describe.skip` would keep the suite green too, but nothing would ever prompt the
 * un-skip; a literal `import` of the missing file would break the whole file at transform time.)
 * The assertions themselves were checked against a temporary spike implementation.
 * TODO step 3: change `it.fails` to `it`, delete the TEMPORARY-PIN, make the import static.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { RPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';
import { loadRPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';

// Non-literal specifier: vite must not resolve it at transform time (the file does not exist yet).
const QUALIFIED_CALL_MODULE = '../../../../src/core/ingestion/languages/r/qualified-call.js';

type Locality = 'local' | 'external' | 'unknown';
interface QualifiedCallModule {
  parseRQualifier(raw: string): string | undefined;
  rQualifierLocality(
    pkg: string,
    cfg: RPackageConfig | null,
    filePaths: ReadonlySet<string>,
  ): Locality;
}
const load = (): Promise<QualifiedCallModule> => import(/* @vite-ignore */ QUALIFIED_CALL_MODULE);

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'lang-resolution');

function config(packages: Record<string, string>, truncated?: boolean): RPackageConfig {
  const cfg: RPackageConfig = {
    packages: new Map(Object.entries(packages)),
    namespaceInfoByPackageDir: new Map(),
  };
  // `truncated` is added to RPackageConfig at step 3; the cast keeps this file compiling now.
  return truncated === undefined ? cfg : Object.assign(cfg, { truncated });
}

describe('parseRQualifier', () => {
  const cases: readonly (readonly [raw: string, expected: string | undefined])[] = [
    ['pkg::f', 'pkg'],
    ['pkg:::f', 'pkg'],
    ['pkg ::: f', 'pkg'],
    ['pkg  ::  f', 'pkg'],
    ['"pkg"::f', 'pkg'],
    ["'pkg'::f", 'pkg'],
    ['`pkg`::f', 'pkg'],
    ['my.pkg::f', 'my.pkg'],
    ['not a qualifier', undefined],
    ['::f', undefined],
  ];

  // TEMPORARY-PIN (remove at step 3): the module is absent, so the failures above are the
  // intended "not implemented yet" and not a typo in the specifier.
  it('TEMPORARY-PIN: languages/r/qualified-call.ts does not exist yet', async () => {
    await expect(load()).rejects.toThrow();
  });

  for (const [raw, expected] of cases) {
    it.fails(`TODO step 3: ${JSON.stringify(raw)} -> ${JSON.stringify(expected)}`, async () => {
      expect((await load()).parseRQualifier(raw)).toBe(expected);
    });
  }
});

describe('rQualifierLocality', () => {
  const paths = (...p: string[]): ReadonlySet<string> => new Set(p);

  const cases: readonly {
    readonly title: string;
    readonly pkg: string;
    readonly cfg: RPackageConfig | null;
    readonly files: ReadonlySet<string>;
    readonly expected: Locality;
  }[] = [
    {
      title: 'a package in the config is local',
      pkg: 'renamed',
      cfg: config({ renamed: 'renamed_impl' }),
      files: paths('renamed_impl/R/a.R'),
      expected: 'local',
    },
    {
      title: 'a package in the config is local even when its discovery was truncated',
      pkg: 'pkg',
      cfg: config({ pkg: 'pkg' }, true),
      files: paths('pkg/R/a.R'),
      expected: 'local',
    },
    {
      title: 'a root-level package is local through the config',
      pkg: 'rootpkg',
      cfg: config({ rootpkg: '' }),
      files: paths('R/a.R'),
      expected: 'local',
    },
    {
      title: 'not in the config but a parsed file sits under <pkg>/R/ (no DESCRIPTION)',
      pkg: 'pkgthird',
      cfg: config({ pkgmain: 'pkgmain' }),
      files: paths('pkgmain/R/a.R', 'pkgthird/R/t.R'),
      expected: 'local',
    },
    {
      title: 'the <pkg>/R/ segment may be nested below the repo root',
      pkg: 'pathpkg',
      cfg: config({ caller: 'caller' }, true),
      files: paths('caller/R/a.R', 'deep/a/b/c/pathpkg/R/p.R'),
      expected: 'local',
    },
    {
      title: 'a path that merely contains the name is not a package directory',
      pkg: 'path',
      cfg: config({ caller: 'caller' }),
      files: paths('caller/R/a.R', 'deep/pathpkg/R/p.R', 'x/path/scripts/s.R'),
      expected: 'external',
    },
    {
      title: 'not local and discovery completed: certainly external',
      pkg: 'dplyr',
      cfg: config({ caller: 'caller' }, false),
      files: paths('caller/R/a.R'),
      expected: 'external',
    },
    {
      title: 'not local and the truncated flag is absent (complete discovery): external',
      pkg: 'dplyr',
      cfg: config({ caller: 'caller' }),
      files: paths('caller/R/a.R'),
      expected: 'external',
    },
    {
      title: 'not local but discovery was truncated: unknown',
      pkg: 'invisiblepkg',
      cfg: config({ caller: 'caller' }, true),
      files: paths('caller/R/a.R', 'deep/a/b/c/impl/R/x.R'),
      expected: 'unknown',
    },
    {
      title: 'no package config could be built: unknown',
      pkg: 'dplyr',
      cfg: null,
      files: paths('R/a.R'),
      expected: 'unknown',
    },
  ];

  for (const c of cases) {
    it.fails(`TODO step 3: ${c.title}`, async () => {
      expect((await load()).rQualifierLocality(c.pkg, c.cfg, c.files)).toBe(c.expected);
    });
  }
});

describe('loadRPackageConfig: discovery completeness on the qualified-call fixtures', () => {
  const load2 = (fixture: string) => loadRPackageConfig(path.join(FIXTURES, fixture));

  // Permanent geometry checks: the fixtures really are shaped as the integration tests assume.
  it('finds every package of r-qualified-calls, including a directory named differently', async () => {
    const cfg = await load2('r-qualified-calls');
    expect([...(cfg?.packages ?? [])].sort()).toEqual([
      ['altlib', 'altlib'],
      ['caller', 'caller'],
      ['duplib', 'duplib'],
      ['locallib', 'locallib'],
      ['provlib', 'provlib'],
      ['renamed', 'renamed_impl'],
    ]);
  });

  it('does not find the packages nested below depth 3 in r-qualified-calls-truncated', async () => {
    const cfg = await load2('r-qualified-calls-truncated');
    expect([...(cfg?.packages ?? [])]).toEqual([['caller', 'caller']]);
  });

  // TEMPORARY-PIN (remove at step 3): the flag does not exist yet.
  it('TEMPORARY-PIN: RPackageConfig carries no truncated flag today', async () => {
    for (const fixture of ['r-qualified-calls', 'r-qualified-calls-truncated']) {
      const cfg = await load2(fixture);
      expect((cfg as { truncated?: boolean } | null)?.truncated).toBeUndefined();
    }
  });

  it.fails('TODO step 3: truncated is false when the walk completed', async () => {
    expect(((await load2('r-qualified-calls')) as { truncated?: boolean } | null)?.truncated).toBe(
      false,
    );
  });

  it.fails(
    'TODO step 3: truncated is true when a directory below depth 3 was skipped',
    async () => {
      expect(
        ((await load2('r-qualified-calls-truncated')) as { truncated?: boolean } | null)?.truncated,
      ).toBe(true);
    },
  );
});
