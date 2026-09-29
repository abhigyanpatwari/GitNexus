/**
 * R NAMESPACE `importFrom()` binding (kaybenleroll/GitNexus#2, step 3):
 *
 *  - `rPackageDirForFile`: which package's `R/` directory a file belongs to;
 *  - `populateRNamespaceImports`: synthesised `named` imports for local
 *    providers (last-wins, self-import drop, external skip, own-package mask);
 *  - `resolveRImportTarget`'s `named` branch: local-package check, dotted-name
 *    guards, NAMESPACE export check, top-level-definition lookup, and the
 *    "builds no workspace file index" property.
 *
 * ParsedFiles come from the real R extractor; package configs are built by hand
 * (`RPackageConfig` has no other constructor than `loadRPackageConfig`).
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import { populateClassOwnedMembers } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type {
  RNamespaceInfo,
  RPackageConfig,
} from '../../../../src/core/ingestion/language-config.js';
import {
  populateRNamespaceImports,
  rFileTopLevel,
  rPackageDirForFile,
  rRecordedPackageTopLevelNames,
} from '../../../../src/core/ingestion/languages/r/namespace-imports.js';
import { resolveRImportTarget } from '../../../../src/core/ingestion/import-resolvers/r.js';
import { CountingSet } from '../../../helpers/counting-file-set.js';

// ─── builders ───────────────────────────────────────────────────────────────

function parse(src: string, filePath: string): ParsedFile {
  const parsed = extractParsedFile(rProvider, src, filePath);
  if (parsed === undefined) throw new Error(`no ParsedFile for ${filePath}`);
  populateClassOwnedMembers(parsed);
  return parsed;
}

interface NsSpec {
  readonly exports?: readonly string[];
  readonly exportPatterns?: readonly RegExp[];
  readonly importFrom?: readonly (readonly [pkg: string, name: string])[];
  /** Omit the NAMESPACE entry altogether (package without a NAMESPACE file). */
  readonly none?: boolean;
}

function config(
  packages: Record<string, string>,
  namespaces: Record<string, NsSpec> = {},
): RPackageConfig {
  const namespaceInfoByPackageDir = new Map<string, RNamespaceInfo>();
  for (const [name, dir] of Object.entries(packages)) {
    const spec = namespaces[name];
    if (spec === undefined || spec.none === true) continue;
    namespaceInfoByPackageDir.set(dir, {
      hasNamespaceFile: true,
      namedExports: new Set(spec.exports ?? []),
      exportPatterns: [...(spec.exportPatterns ?? [])],
      importFrom: (spec.importFrom ?? []).map(([pkg, name]) => ({ pkg, name })),
    });
  }
  return { packages: new Map(Object.entries(packages)), namespaceInfoByPackageDir };
}

const namedImportsOf = (parsed: ParsedFile): string[] =>
  parsed.parsedImports
    .filter((i): i is Extract<ParsedImport, { kind: 'named' }> => i.kind === 'named')
    .map((i) => `${i.targetRaw}::${i.importedName}`)
    .sort();

const populate = (files: ParsedFile[], cfg: RPackageConfig | null): ParsedFile[] => {
  populateRNamespaceImports(files, { resolutionConfig: cfg ?? undefined });
  return files;
};

// ─── rPackageDirForFile ─────────────────────────────────────────────────────

describe('rPackageDirForFile', () => {
  const cfg = config({ alpha: 'alpha', beta: 'sub/beta' });

  it('finds the package whose R/ directory holds the file', () => {
    expect(rPackageDirForFile('alpha/R/a.R', cfg)).toEqual({ name: 'alpha', dir: 'alpha' });
  });

  it('finds a nested package directory', () => {
    expect(rPackageDirForFile('sub/beta/R/b.R', cfg)).toEqual({ name: 'beta', dir: 'sub/beta' });
  });

  it('accepts Windows separators', () => {
    expect(rPackageDirForFile('alpha\\R\\a.R', cfg)?.name).toBe('alpha');
  });

  it('returns nothing for a file outside every package R/ directory', () => {
    expect(
      [
        'alpha/tests/testthat/test-a.R',
        'alpha/scripts/x.R',
        'alpha/plumber.R',
        'other/R/x.R',
        'alphaR/R/x.R',
      ].map((f) => rPackageDirForFile(f, cfg)),
    ).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('handles a root-level package (dir "") without building a "/" prefix', () => {
    const root = config({ rootpkg: '' });
    expect([
      rPackageDirForFile('R/a.R', root),
      rPackageDirForFile('R/sub/a.R', root),
      rPackageDirForFile('tests/R/a.R', root),
      rPackageDirForFile('plumber.R', root),
    ]).toEqual([{ name: 'rootpkg', dir: '' }, { name: 'rootpkg', dir: '' }, undefined, undefined]);
  });

  it('prefers the longest package directory when package directories nest', () => {
    const nested = config({ outer: 'outer', inner: 'outer/inner' });
    expect(rPackageDirForFile('outer/inner/R/x.R', nested)?.name).toBe('inner');
    expect(rPackageDirForFile('outer/R/x.R', nested)?.name).toBe('outer');
  });

  it('returns nothing without a config', () => {
    expect([
      rPackageDirForFile('alpha/R/a.R', null),
      rPackageDirForFile('a/R/a.R', undefined),
    ]).toEqual([undefined, undefined]);
  });
});

// ─── rFileTopLevel ──────────────────────────────────────────────────────────

describe('rFileTopLevel', () => {
  const parsed = parse(
    [
      'x <- 1',
      'tidy <- function(a) { inner <- function(b) b; inner(a) }',
      'print.tidy <- function(x) x',
      'Scorer <- R6::R6Class("Scorer", public = list(method_only = function(z) z))',
    ].join('\n'),
    'p/R/a.R',
  );
  const top = rFileTopLevel(parsed);

  it('lists top-level functions and classes, dotted names included', () => {
    expect([...top.names].sort()).toEqual(['Scorer', 'print.tidy', 'tidy']);
  });

  it('excludes nested functions, R6 members and plain variables', () => {
    expect([...top.names].filter((n) => ['inner', 'method_only', 'x'].includes(n))).toEqual([]);
  });

  it('records the tail of every dotted name', () => {
    expect([...top.dottedTails]).toEqual(['tidy']);
  });
});

// ─── populateRNamespaceImports ──────────────────────────────────────────────

describe('populateRNamespaceImports', () => {
  const pkgs = { analytics: 'analytics', scorelib: 'scorelib', legacyscore: 'legacyscore' };
  const provider = (path: string, names: string[]) =>
    parse(names.map((n) => `${n} <- function(d) d`).join('\n'), path);
  const callerFile = (path: string, src = 'noop <- function() 1') => parse(src, path);

  it('synthesises a named import for a local-package importFrom() into every R/ file of the caller', () => {
    const files = populate(
      [
        callerFile('analytics/R/a.R'),
        callerFile('analytics/R/b.R'),
        callerFile('analytics/R/c.R'),
        provider('scorelib/R/s.R', ['tidy_scores']),
      ],
      config(pkgs, {
        analytics: { importFrom: [['scorelib', 'tidy_scores']] },
        scorelib: { exports: ['tidy_scores'] },
      }),
    );
    expect(files.map(namedImportsOf)).toEqual([
      ['scorelib::tidy_scores'],
      ['scorelib::tidy_scores'],
      ['scorelib::tidy_scores'],
      [],
    ]);
  });

  it('shapes the import as a per-name, un-renamed named import of the package', () => {
    const [caller] = populate(
      [callerFile('analytics/R/a.R'), provider('scorelib/R/s.R', ['tidy_scores'])],
      config(pkgs, { analytics: { importFrom: [['scorelib', 'tidy_scores']] } }),
    );
    expect(caller.parsedImports).toEqual([
      {
        kind: 'named',
        localName: 'tidy_scores',
        importedName: 'tidy_scores',
        targetRaw: 'scorelib',
      },
    ]);
  });

  it('skips an importFrom() of an external package (nothing local to bind)', () => {
    const files = populate(
      [callerFile('analytics/R/a.R'), provider('scorelib/R/s.R', ['mutate'])],
      config(pkgs, { analytics: { importFrom: [['dplyr', 'mutate']] } }),
    );
    expect(files.map(namedImportsOf)).toEqual([[], []]);
  });

  it('drops a self-import (the parser returns it; the package cannot import from itself)', () => {
    const files = populate(
      [callerFile('analytics/R/a.R'), provider('scorelib/R/s.R', ['f'])],
      config(pkgs, { analytics: { importFrom: [['analytics', 'f']] } }),
    );
    expect(files.map(namedImportsOf)).toEqual([[], []]);
  });

  it('skips a name the caller package defines at top level, even in a different file', () => {
    const files = populate(
      [
        callerFile('analytics/R/a.R', 'uses_it <- function() 1'),
        callerFile('analytics/R/own.R', 'own_dup <- function(d) d'),
        provider('scorelib/R/s.R', ['own_dup', 'other_fn']),
      ],
      config(pkgs, {
        analytics: {
          importFrom: [
            ['scorelib', 'own_dup'],
            ['scorelib', 'other_fn'],
          ],
        },
      }),
    );
    expect(files.map(namedImportsOf)).toEqual([['scorelib::other_fn'], ['scorelib::other_fn'], []]);
  });

  it('does not treat an R6 method of the caller package as a top-level definition', () => {
    const files = populate(
      [
        callerFile(
          'analytics/R/own.R',
          'Runner <- R6::R6Class("Runner", public = list(tidy_scores = function(d) d))',
        ),
        provider('scorelib/R/s.R', ['tidy_scores']),
      ],
      config(pkgs, { analytics: { importFrom: [['scorelib', 'tidy_scores']] } }),
    );
    expect(namedImportsOf(files[0])).toEqual(['scorelib::tidy_scores']);
  });

  it('keeps only the last entry when two local packages import one name (last wins)', () => {
    const files = populate(
      [
        callerFile('analytics/R/a.R'),
        provider('scorelib/R/s.R', ['dup']),
        provider('legacyscore/R/l.R', ['dup']),
      ],
      config(pkgs, {
        analytics: {
          importFrom: [
            ['scorelib', 'dup'],
            ['legacyscore', 'dup'],
          ],
        },
      }),
    );
    expect(namedImportsOf(files[0])).toEqual(['legacyscore::dup']);
  });

  it('synthesises nothing when an external package is imported LAST for a name (no resurrection)', () => {
    const files = populate(
      [callerFile('analytics/R/a.R'), provider('scorelib/R/s.R', ['dup_ext'])],
      config(pkgs, {
        analytics: {
          importFrom: [
            ['scorelib', 'dup_ext'],
            ['dplyr', 'dup_ext'],
          ],
        },
      }),
    );
    expect(namedImportsOf(files[0])).toEqual([]);
  });

  it('binds the local package when it is imported after an external one', () => {
    const files = populate(
      [callerFile('analytics/R/a.R'), provider('scorelib/R/s.R', ['dup_ext'])],
      config(pkgs, {
        analytics: {
          importFrom: [
            ['dplyr', 'dup_ext'],
            ['scorelib', 'dup_ext'],
          ],
        },
      }),
    );
    expect(namedImportsOf(files[0])).toEqual(['scorelib::dup_ext']);
  });

  it('touches only R/ files: scripts/ and tests/ of the caller package get no import', () => {
    const files = populate(
      [
        callerFile('analytics/R/a.R'),
        callerFile('analytics/scripts/x.R'),
        callerFile('analytics/tests/testthat/test-x.R'),
        callerFile('analytics/plumber.R'),
        provider('scorelib/R/s.R', ['f']),
      ],
      config(pkgs, { analytics: { importFrom: [['scorelib', 'f']] } }),
    );
    expect(files.map(namedImportsOf)).toEqual([['scorelib::f'], [], [], [], []]);
  });

  it('handles a root-level caller package', () => {
    const files = populate(
      [callerFile('R/a.R'), callerFile('scripts/x.R'), provider('scorelib/R/s.R', ['f'])],
      config(
        { rootpkg: '', scorelib: 'scorelib' },
        { rootpkg: { importFrom: [['scorelib', 'f']] } },
      ),
    );
    expect(files.map(namedImportsOf)).toEqual([['scorelib::f'], [], []]);
  });

  it('replaces array entries with frozen copies and leaves the originals untouched', () => {
    const original = callerFile('analytics/R/a.R');
    const files = [original, provider('scorelib/R/s.R', ['f'])];
    populate(files, config(pkgs, { analytics: { importFrom: [['scorelib', 'f']] } }));
    expect([
      files[0] === original,
      Object.isFrozen(files[0]),
      original.parsedImports.length,
    ]).toEqual([false, true, 0]);
  });

  it('is idempotent: a second pass does not duplicate the synthesised imports', () => {
    const files = [callerFile('analytics/R/a.R'), provider('scorelib/R/s.R', ['f'])];
    const cfg = config(pkgs, { analytics: { importFrom: [['scorelib', 'f']] } });
    populate(files, cfg);
    populate(files, cfg);
    expect(namedImportsOf(files[0])).toEqual(['scorelib::f']);
  });

  it('is a no-op without a config, with no packages, or when no package imports a local one', () => {
    const files = [callerFile('analytics/R/a.R'), provider('scorelib/R/s.R', ['f'])];
    const before = [...files];
    populate(files, null);
    populate(files, config({}));
    populate(files, config(pkgs, { analytics: { importFrom: [['dplyr', 'f']] } }));
    populate(files, config(pkgs, { scorelib: { exports: ['f'] } }));
    expect(files.every((f, i) => f === before[i])).toBe(true);
  });

  it("records each participating package's top-level names for the fallback veto", () => {
    const cfg = config(pkgs, { analytics: { importFrom: [['scorelib', 'f']] } });
    populate(
      [
        callerFile('analytics/R/a.R', 'run <- function() 1'),
        provider('scorelib/R/s.R', ['f', 'g']),
        provider('legacyscore/R/l.R', ['h']),
      ],
      cfg,
    );
    const recorded = rRecordedPackageTopLevelNames(cfg);
    expect([
      [...(recorded?.get('analytics') ?? [])],
      [...(recorded?.get('scorelib') ?? [])].sort(),
      recorded?.has('legacyscore'),
    ]).toEqual([['run'], ['f', 'g'], false]);
  });

  it('records nothing for an unrelated config object', () => {
    expect(rRecordedPackageTopLevelNames(config(pkgs))).toBeUndefined();
    expect(rRecordedPackageTopLevelNames(undefined)).toBeUndefined();
  });
});

// ─── resolveRImportTarget: named branch ─────────────────────────────────────

describe('resolveRImportTarget — named imports (NAMESPACE importFrom)', () => {
  const namedImport = (pkg: string, name: string): ParsedImport => ({
    kind: 'named',
    localName: name,
    importedName: name,
    targetRaw: pkg,
  });

  interface Setup {
    readonly cfg: RPackageConfig;
    readonly files: ParsedFile[];
  }

  /** scorelib provider files (source per path) plus a caller file. */
  function setup(
    providerSources: Record<string, string>,
    ns: NsSpec | undefined,
    dir = 'scorelib',
  ): Setup {
    const files = [
      parse('run <- function() 1', 'analytics/R/use.R'),
      ...Object.entries(providerSources).map(([p, src]) => parse(src, p)),
    ];
    return {
      cfg: config(
        { analytics: 'analytics', scorelib: dir },
        ns === undefined ? {} : { scorelib: ns },
      ),
      files,
    };
  }

  const resolve = (s: Setup, pkg: string, name: string) =>
    resolveRImportTarget(pkg, 'analytics/R/use.R', new Set(s.files.map((f) => f.filePath)), s.cfg, {
      parsedFiles: s.files,
      parsedImport: namedImport(pkg, name),
    });

  const F = 'scorelib/R/s.R';

  it('returns nothing for an external package', () => {
    const s = setup({ [F]: 'mutate <- function(d) d' }, { exports: ['mutate'] });
    expect(resolve(s, 'dplyr', 'mutate')).toBeNull();
  });

  it('returns nothing without a package config', () => {
    const s = setup({ [F]: 'f <- function(d) d' }, undefined);
    expect(
      resolveRImportTarget('scorelib', 'analytics/R/use.R', new Set([F]), undefined, {
        parsedFiles: s.files,
        parsedImport: namedImport('scorelib', 'f'),
      }),
    ).toBeNull();
  });

  it('returns nothing when the local package has no definition of the name', () => {
    const s = setup({ [F]: 'other <- function(d) d' }, { exports: ['f', 'other'] });
    expect(resolve(s, 'scorelib', 'f')).toBeNull();
  });

  it('returns only the files that define the name at top level', () => {
    const s = setup(
      {
        [F]: 'f <- function(d) d',
        'scorelib/R/t.R': 'g <- function(d) d',
        'scorelib/R/u.R': 'f <- function(d) d',
      },
      { exports: ['f', 'g'] },
    );
    expect(resolve(s, 'scorelib', 'f')).toEqual([F, 'scorelib/R/u.R']);
  });

  it('ignores same-named definitions outside the package R/ directory and in other packages', () => {
    const s = setup(
      {
        'scorelib/scripts/x.R': 'f <- function(d) d',
        'legacyscore/R/l.R': 'f <- function(d) d',
      },
      { exports: ['f'] },
    );
    expect(resolve(s, 'scorelib', 'f')).toBeNull();
  });

  it('does not bind an R6 method, nor a nested function, as a top-level definition', () => {
    const s = setup(
      {
        [F]: [
          'Scorer <- R6::R6Class("Scorer", public = list(method_only = function(d) d))',
          'host <- function(d) { nested_only <- function(y) y; nested_only(d) }',
        ].join('\n'),
      },
      { exports: ['method_only', 'nested_only'] },
    );
    expect([resolve(s, 'scorelib', 'method_only'), resolve(s, 'scorelib', 'nested_only')]).toEqual([
      null,
      null,
    ]);
  });

  it('resolves an R6 class defined at top level', () => {
    const s = setup(
      { [F]: 'Scorer <- R6::R6Class("Scorer", public = list())' },
      { exports: ['Scorer'] },
    );
    expect(resolve(s, 'scorelib', 'Scorer')).toEqual([F]);
  });

  it('strips quotes around the package name', () => {
    const s = setup({ [F]: 'f <- function(d) d' }, { exports: ['f'] });
    expect(resolve(s, '"scorelib"', 'f')).toEqual([F]);
  });

  describe('dotted-name guards', () => {
    it('refuses a dotted importedName (finalize can never bind it)', () => {
      const s = setup(
        { [F]: 'normalise.scores <- function(d) d' },
        { exports: ['normalise.scores'] },
      );
      expect(resolve(s, 'scorelib', 'normalise.scores')).toBeNull();
    });

    it('refuses tidy when print.tidy is defined BEFORE it in the same file', () => {
      const s = setup(
        { [F]: 'print.tidy <- function(x) x\ntidy <- function(d) d' },
        { exports: ['tidy'] },
      );
      expect(resolve(s, 'scorelib', 'tidy')).toBeNull();
    });

    it('refuses tidy when print.tidy is defined AFTER it too (order-blind, conservative)', () => {
      const s = setup(
        { [F]: 'tidy <- function(d) d\nprint.tidy <- function(x) x' },
        { exports: ['tidy'] },
      );
      expect(resolve(s, 'scorelib', 'tidy')).toBeNull();
    });

    it('does not fire for an underscore name in the same file as dotted defs', () => {
      const s = setup(
        { [F]: 'print.tidy <- function(x) x\nplain_fn <- function(d) d' },
        { exports: ['plain_fn'] },
      );
      expect(resolve(s, 'scorelib', 'plain_fn')).toEqual([F]);
    });

    it('does not fire when the dotted def sits in a different file from the definition', () => {
      const s = setup(
        {
          [F]: 'tidy <- function(d) d',
          'scorelib/R/t.R': 'print.tidy <- function(x) x',
        },
        { exports: ['tidy'] },
      );
      expect(resolve(s, 'scorelib', 'tidy')).toEqual([F]);
    });

    it('does not fire for a same-named R6 method (only Module-scope bindings count)', () => {
      const s = setup(
        {
          [F]: [
            'Scorer <- R6::R6Class("Scorer", public = list(tidy = function(d) d))',
            'tidy <- function(d) d',
          ].join('\n'),
        },
        { exports: ['tidy'] },
      );
      expect(resolve(s, 'scorelib', 'tidy')).toEqual([F]);
    });
  });

  describe('NAMESPACE export check', () => {
    const src = 'f <- function(d) d\nhidden <- function(d) d\n`%+%` <- function(a, b) a';

    it('resolves a name listed in export()', () => {
      const s = setup({ [F]: src }, { exports: ['f'] });
      expect(resolve(s, 'scorelib', 'f')).toEqual([F]);
    });

    it('refuses a defined name the provider NAMESPACE does not export', () => {
      const s = setup({ [F]: src }, { exports: ['f'] });
      expect(resolve(s, 'scorelib', 'hidden')).toBeNull();
    });

    it('resolves a name matched by an exportPattern()', () => {
      const s = setup({ [F]: src }, { exportPatterns: [/^hid/] });
      expect(resolve(s, 'scorelib', 'hidden')).toEqual([F]);
    });

    it('matches a backticked export() entry against the unquoted name (backticks stripped)', () => {
      const s = setup({ [F]: src }, { exports: ['`%+%`'] });
      // Export check passes; the def keeps its backticks, so the lookup ends with no file.
      expect(resolve(s, 'scorelib', '%+%')).toBeNull();
      const t = setup({ [F]: 'g <- function(d) d' }, { exports: ['`g`'] });
      expect(resolve(t, 'scorelib', 'g')).toEqual([F]);
    });

    it('treats a package without a NAMESPACE file as exporting everything', () => {
      const s = setup({ [F]: src }, undefined);
      expect(resolve(s, 'scorelib', 'hidden')).toEqual([F]);
    });

    it('treats a package whose NAMESPACE entry is absent as exporting everything', () => {
      const s = setup({ [F]: src }, { none: true });
      expect(resolve(s, 'scorelib', 'hidden')).toEqual([F]);
    });

    it('checks a root-level provider package (dir "")', () => {
      const files = [
        parse('run <- function() 1', 'analytics/R/use.R'),
        parse('f <- function(d) d\nhidden <- function(d) d', 'R/s.R'),
      ];
      const cfg = config({ analytics: 'analytics', rootpkg: '' }, { rootpkg: { exports: ['f'] } });
      const ask = (name: string) =>
        resolveRImportTarget('rootpkg', 'analytics/R/use.R', new Set(), cfg, {
          parsedFiles: files,
          parsedImport: namedImport('rootpkg', name),
        });
      expect([ask('f'), ask('hidden')]).toEqual([['R/s.R'], null]);
    });

    it('characterisation: a POSIX-class exportPattern never matches in a JS RegExp, so every name is refused', () => {
      // `exportPattern("^[[:alpha:]]+")` (the RStudio default) compiles to a RegExp that matches
      // nothing, so the export check judges every name non-exported and the import degrades to
      // the baseline name-guess. Existing loadRPackageConfig behaviour, not fixed here.
      const s = setup(
        { [F]: 'tidy_scores <- function(d) d' },
        {
          exportPatterns: [new RegExp('^[[:alpha:]]+')],
        },
      );
      expect(resolve(s, 'scorelib', 'tidy_scores')).toBeNull();
    });
  });

  describe('workspace file index', () => {
    it('builds no file index for named imports (the file Set is never traversed)', () => {
      const s = setup({ [F]: 'f <- function(d) d' }, { exports: ['f'] });
      const paths = new CountingSet(s.files.map((f) => f.filePath));
      for (let i = 0; i < 25; i++) {
        resolveRImportTarget('scorelib', 'analytics/R/use.R', paths, s.cfg, {
          parsedFiles: s.files,
          parsedImport: namedImport('scorelib', 'f'),
        });
        resolveRImportTarget('dplyr', 'analytics/R/use.R', paths, s.cfg, {
          parsedFiles: s.files,
          parsedImport: namedImport('dplyr', 'f'),
        });
      }
      expect(paths.scans).toBe(0);
    });

    it('still builds one memoised index for wildcard imports', () => {
      const s = setup({ [F]: 'f <- function(d) d' }, { exports: ['f'] });
      const paths = new CountingSet(s.files.map((f) => f.filePath));
      for (let i = 0; i < 25; i++) {
        resolveRImportTarget('scorelib', 'analytics/R/use.R', paths, s.cfg, {
          parsedFiles: s.files,
          parsedImport: { kind: 'wildcard', targetRaw: 'scorelib' },
        });
      }
      expect(paths.scans).toBe(1);
    });

    it('indexes the parsed files once for many named imports', () => {
      const s = setup({ [F]: 'f <- function(d) d\ng <- function(d) d' }, { exports: ['f', 'g'] });
      const first = resolve(s, 'scorelib', 'f');
      const second = resolve(s, 'scorelib', 'f');
      expect(second).toBe(first);
    });
  });

  describe('non-named kinds and context-less calls', () => {
    it('leaves a wildcard import of an external package unresolved', () => {
      const s = setup({ [F]: 'f <- function(d) d' }, { exports: ['f'] });
      expect(
        resolveRImportTarget('dplyr', 'analytics/R/use.R', new Set([F]), s.cfg, {
          parsedFiles: s.files,
          parsedImport: { kind: 'wildcard', targetRaw: 'dplyr' },
        }),
      ).toBeNull();
    });

    it('resolves a wildcard import of a local package to all its R/ files, unchanged', () => {
      const s = setup(
        { [F]: 'f <- function(d) d', 'scorelib/R/t.R': 'g <- function(d) d' },
        { exports: ['f'] },
      );
      expect(
        resolveRImportTarget(
          'scorelib',
          'analytics/R/use.R',
          new Set(s.files.map((f) => f.filePath)),
          s.cfg,
          { parsedFiles: s.files, parsedImport: { kind: 'wildcard', targetRaw: 'scorelib' } },
        ),
      ).toEqual([F, 'scorelib/R/t.R']);
    });

    it('a context-less call is treated as before (suffix resolution, no named branch)', () => {
      const s = setup({ [F]: 'f <- function(d) d' }, { exports: ['f'] });
      expect(
        resolveRImportTarget(
          'scorelib',
          'analytics/R/use.R',
          new Set(s.files.map((f) => f.filePath)),
          s.cfg,
        ),
      ).toEqual([F]);
    });
  });
});
