/**
 * R qualified-call helpers (fork #7):
 *
 *  - `parseRQualifier(raw)`: the package named by a `@reference.qualified-name` text;
 *  - `rQualifierLocality(pkg, cfg, filePaths)`: `local` | `external` | `unknown`;
 *  - `loadRPackageConfig` sets `RPackageConfig.truncated` only when a subtree its depth-3 /
 *    200-directory walk skipped may hide an undiscovered package (or a directory of the walk
 *    is unreadable); skipped subtrees without a package do not truncate;
 *  - the global-name-fallback veto's qualifier rule (`isRGlobalNameFallbackPlausible`).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';
import {
  hidesUndiscoveredPackage,
  loadRPackageConfig,
} from '../../../../src/core/ingestion/languages/r/package-config.js';
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

  it('truncated is true when a skipped directory hides an undiscovered package', async () => {
    // deep/a/b/c/impl holds `Package: invisiblepkg`, below the depth limit.
    expect((await load2('r-qualified-calls-truncated'))?.truncated).toBe(true);
  });

  it('truncated is false when the skipped directories (tests/testthat/fixtures) hold no package', async () => {
    const cfg = await load2('r-qualified-calls-deep-fixtures');
    expect([...(cfg?.packages ?? [])]).toEqual([['deepcaller', 'caller']]);
    expect(cfg?.truncated).toBe(false);
  });
});

describe('loadRPackageConfig: zero packages found', () => {
  async function withTree(build: (root: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r-no-description-'));
    try {
      await build(root);
      return await loadRPackageConfig(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('returns a complete empty config when discovery finds no package', async () => {
    const cfg = await loadRPackageConfig(path.join(FIXTURES, 'r-no-description'));
    expect(cfg).not.toBeNull();
    expect(cfg?.packages.size).toBe(0);
    expect(cfg?.truncated).toBe(false);
  });

  it('keeps truncated set when no package is found but a skipped subtree hides one', async () => {
    const cfg = await loadRPackageConfig(path.join(FIXTURES, 'r-no-description-truncated'));
    expect(cfg?.packages.size).toBe(0);
    expect(cfg?.truncated).toBe(true);
  });

  it('returns a complete empty config for an R-only temporary tree without DESCRIPTION', async () => {
    const cfg = await withTree(async (root) => {
      await fs.mkdir(path.join(root, 'R'));
      await fs.writeFile(path.join(root, 'R', 'a.R'), 'f <- function() 1\n');
    });
    expect(cfg?.truncated).toBe(false);
  });

  it('rQualifierLocality: complete empty config proves external; truncated stays unknown', () => {
    const empty = config({}, false);
    expect(rQualifierLocality('dplyr', empty, new Set(['R/a.R']))).toBe('external');
    expect(rQualifierLocality('dplyr', config({}, true), new Set(['R/a.R']))).toBe('unknown');
    expect(rQualifierLocality('dplyr', null, new Set(['R/a.R']))).toBe('unknown');
    // a <pkg>/R/ path still makes the package local without a DESCRIPTION
    expect(rQualifierLocality('pathpkg', empty, new Set(['pathpkg/R/a.R']))).toBe('local');
  });
});

describe('loadRPackageConfig: truncation only when a skipped subtree hides an undiscovered package', () => {
  // Layout: root/DESCRIPTION (rootpkg). `skipDir` is the first directory below the depth-3
  // limit: root(0) > a(1) > b(2) > c(3) lists d, which is skipped.
  const SKIP = ['a', 'b', 'c', 'd'];

  async function withRepo(
    build: (root: string) => Promise<void>,
  ): Promise<Awaited<ReturnType<typeof loadRPackageConfig>>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r-truncated-hidden-'));
    try {
      await fs.writeFile(path.join(root, 'DESCRIPTION'), 'Package: rootpkg\n');
      await build(root);
      return await loadRPackageConfig(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const writePkg = async (dir: string, name: string): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'DESCRIPTION'), `Package: ${name}\n`);
  };

  it('a skipped directory with no package inside is not truncated', async () => {
    const cfg = await withRepo(async (root) => {
      await fs.mkdir(path.join(root, ...SKIP, 'data', 'raw'), { recursive: true });
      await fs.writeFile(path.join(root, ...SKIP, 'data', 'raw', 'x.csv'), 'a,b\n');
    });
    expect(cfg?.truncated).toBe(false);
  });

  it('a skipped subtree with a real package of an undiscovered name is truncated', async () => {
    const cfg = await withRepo((root) => writePkg(path.join(root, ...SKIP, 'realpkg'), 'realpkg'));
    expect(cfg?.truncated).toBe(true);
  });

  it('a skipped subtree with only a same-name copy of a discovered package is not truncated', async () => {
    const cfg = await withRepo((root) => writePkg(path.join(root, ...SKIP, 'copy'), 'rootpkg'));
    expect(cfg?.truncated).toBe(false);
  });

  it('a package at depth 5 (hidden below the skipped directory itself) is truncated', async () => {
    const cfg = await withRepo((root) =>
      writePkg(path.join(root, ...SKIP, 'e', 'deeppkg'), 'deeppkg'),
    );
    expect(cfg?.truncated).toBe(true);
  });

  it('a DESCRIPTION under node_modules, .git or .Rproj.user of a skipped subtree is ignored', async () => {
    const cfg = await withRepo(async (root) => {
      await writePkg(path.join(root, ...SKIP, 'node_modules', 'jspkg'), 'jspkg');
      await writePkg(path.join(root, ...SKIP, '.git', 'gitpkg'), 'gitpkg');
      await writePkg(path.join(root, ...SKIP, '.Rproj.user', 'rprojpkg'), 'rprojpkg');
    });
    expect(cfg?.truncated).toBe(false);
  });

  it('a package left in the queue when the 200-directory cap stops the walk is truncated', async () => {
    const cfg = await withRepo(async (root) => {
      for (let i = 0; i < 210; i++) await fs.mkdir(path.join(root, `filler${String(i)}`));
      // Sorts last, so it is still queued when the cap is hit.
      await writePkg(path.join(root, 'zz_hidden'), 'zzhidden');
    });
    expect(cfg?.truncated).toBe(true);
  });

  it('a skipped subtree larger than the 5000-directory budget is truncated', async () => {
    const cfg = await withRepo(async (root) => {
      const big = path.join(root, ...SKIP);
      await fs.mkdir(big, { recursive: true });
      await Promise.all(
        Array.from({ length: 5001 }, (_, i) => fs.mkdir(path.join(big, `d${String(i)}`))),
      );
    });
    expect(cfg?.truncated).toBe(true);
  }, 30000);

  it('an unreadable skipped directory is truncated', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads anything
    let locked = '';
    try {
      const cfg = await withRepo(async (root) => {
        locked = path.join(root, ...SKIP, 'locked');
        await fs.mkdir(locked, { recursive: true });
        await fs.chmod(locked, 0o000);
      });
      expect(cfg?.truncated).toBe(true);
    } finally {
      if (locked) await fs.chmod(locked, 0o755).catch(() => undefined);
    }
  });
});

describe('hidesUndiscoveredPackage', () => {
  it('shares one budget across all roots (exceeded on the second root)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r-hidden-budget-'));
    try {
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      for (const d of [a, b]) {
        await fs.mkdir(path.join(d, 'x'), { recursive: true });
      }
      // Each root costs 2 directories (itself + x): 4 in total.
      expect(await hidesUndiscoveredPackage([a, b], new Set(), 4)).toBe(false);
      expect(await hidesUndiscoveredPackage([a, b], new Set(), 3)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('a nonexistent root cannot be read: true', async () => {
    expect(
      await hidesUndiscoveredPackage([path.join(os.tmpdir(), 'r-no-such-dir-x9')], new Set()),
    ).toBe(true);
  });

  it('no roots: false', async () => {
    expect(await hidesUndiscoveredPackage([], new Set())).toBe(false);
  });
});

describe('loadRPackageConfig: directory cap', () => {
  it('truncated is false when the directories left queued by the 200-directory cap hold no package', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r-cap-empty-'));
    try {
      await fs.writeFile(path.join(root, 'DESCRIPTION'), 'Package: rootpkg\n');
      for (let i = 0; i < 210; i++) await fs.mkdir(path.join(root, `filler${String(i)}`));
      const cfg = await loadRPackageConfig(root);
      expect([...(cfg?.packages ?? [])]).toEqual([['rootpkg', '']]);
      expect(cfg?.truncated).toBe(false);
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
