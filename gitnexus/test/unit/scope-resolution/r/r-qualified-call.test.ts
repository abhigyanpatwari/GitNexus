/**
 * R qualified-call helpers (fork #7):
 *
 *  - `parseRQualifier(raw)`: the package named by a `@reference.qualified-name` text;
 *  - `rQualifierLocality(pkg, cfg, filePaths)`: `local` | `external` | `unknown`;
 *  - `loadRPackageConfig` sets `RPackageConfig.truncated` when its depth-3 / 200-directory
 *    walk (or an unreadable directory) left part of the repo unvisited;
 *  - the global-name-fallback veto's qualifier rule (`isRGlobalNameFallbackPlausible`).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';
import { loadRPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';
import {
  parseRQualifier,
  rQualifierLocality,
  type RQualifierLocality,
} from '../../../../src/core/ingestion/languages/r/qualified-call.js';
import {
  isRGlobalNameFallbackPlausible,
  rRecordQualifiedDefinitionCounts,
} from '../../../../src/core/ingestion/languages/r/namespace-imports.js';

type Locality = RQualifierLocality;

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'lang-resolution');

function config(packages: Record<string, string>, truncated?: boolean): RPackageConfig {
  const cfg: RPackageConfig = {
    packages: new Map(Object.entries(packages)),
    namespaceInfoByPackageDir: new Map(),
  };
  return truncated === undefined ? cfg : { ...cfg, truncated };
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

  for (const [raw, expected] of cases) {
    it(`${JSON.stringify(raw)} -> ${JSON.stringify(expected)}`, () => {
      expect(parseRQualifier(raw)).toBe(expected);
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
    it(c.title, () => {
      expect(rQualifierLocality(c.pkg, c.cfg, c.files)).toBe(c.expected);
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

  it('truncated is false when the walk completed', async () => {
    expect((await load2('r-qualified-calls'))?.truncated).toBe(false);
  });

  it('truncated is true when a directory below depth 3 was skipped', async () => {
    expect((await load2('r-qualified-calls-truncated'))?.truncated).toBe(true);
  });
});

describe('loadRPackageConfig: truncation by the directory cap', () => {
  it('truncated is true when the 200-directory cap stops the walk with directories queued', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r-truncated-cap-'));
    try {
      await fs.writeFile(path.join(root, 'DESCRIPTION'), 'Package: rootpkg\n');
      for (let i = 0; i < 210; i++) await fs.mkdir(path.join(root, `filler${String(i)}`));
      const cfg = await loadRPackageConfig(root);
      expect([...(cfg?.packages ?? [])]).toEqual([['rootpkg', '']]);
      expect(cfg?.truncated).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('isRGlobalNameFallbackPlausible: qualifier rule', () => {
  const cfg: RPackageConfig = {
    packages: new Map([
      ['caller', 'caller'],
      ['named', 'named'],
      ['other', 'other'],
    ]),
    namespaceInfoByPackageDir: new Map([
      [
        'caller',
        {
          hasNamespaceFile: true,
          namedExports: new Set(),
          exportPatterns: [],
          importFrom: [{ pkg: 'ext', name: 'mutate' }],
        },
      ],
    ]),
  };
  const verdict = (qualified: string | undefined, candidate: string, config = cfg): boolean =>
    isRGlobalNameFallbackPlausible({
      callerParsed: { filePath: 'caller/R/a.R' },
      candidate: { filePath: candidate },
      resolutionConfig: config,
      site: { name: 'mutate', rawQualifiedName: qualified },
    });

  it('allows a candidate inside the named local package (whatever importFrom says)', () => {
    expect(verdict('named::mutate', 'named/R/m.R')).toBe(true);
  });

  it('vetoes a candidate elsewhere when the named package defines the name', () => {
    rRecordQualifiedDefinitionCounts(cfg, new Map([['named', new Map([['mutate', 1]])]]));
    expect(verdict('named::mutate', 'other/R/o.R')).toBe(false);
  });

  it('falls through to the NAMESPACE rules when the named package defines none (re-export)', () => {
    rRecordQualifiedDefinitionCounts(cfg, new Map([['named', new Map()]]));
    // importFrom(ext, mutate) + a candidate in a third package: today's importFrom veto.
    expect(verdict('named::mutate', 'other/R/o.R')).toBe(false);
    const noImportFrom: RPackageConfig = { ...cfg, namespaceInfoByPackageDir: new Map() };
    rRecordQualifiedDefinitionCounts(noImportFrom, new Map([['named', new Map()]]));
    expect(verdict('named::mutate', 'other/R/o.R', noImportFrom)).toBe(true);
  });

  it('falls through when no counts were recorded for the config', () => {
    const fresh: RPackageConfig = { ...cfg };
    expect(verdict('named::mutate', 'other/R/o.R', fresh)).toBe(false); // importFrom rule, as before
  });

  it('ignores a qualifier naming a package outside the config', () => {
    expect(verdict('elsewhere::mutate', 'other/R/o.R')).toBe(false); // importFrom rule, as before
  });

  it('a site without a qualifier is judged by the NAMESPACE rules only', () => {
    expect(verdict(undefined, 'other/R/o.R')).toBe(false);
    expect(verdict(undefined, 'caller/R/c.R')).toBe(true);
  });
});
