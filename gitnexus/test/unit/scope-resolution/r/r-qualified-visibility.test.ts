/**
 * Export visibility (`public` / `private` / `unknown`) of R package definitions and the rules built
 * on it: `populateRQualifiedCalls` (no qualified site survives without a precise target),
 * the `library()` expansion (strict), the unique-name guess veto (proven private only), the
 * package-tree predicate and the re-export reader. The end-to-end cells are in
 * `integration/resolvers/r-qualified-exports.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import {
  compileRExportPatternDetailed,
  type RExportMatcher,
} from '../../../../src/core/ingestion/languages/r/export-pattern.js';
import { SharedWorkBudget } from '../../../../src/core/ingestion/languages/r/linear-regex.js';
import {
  isRGlobalNameFallbackPlausible,
  parseRQualifierOperator,
  rEnclosingPackageDir,
  rReexportOrigin,
  rSymbolVisibility,
} from '../../../../src/core/ingestion/languages/r/namespace-imports.js';
import {
  rBuildSymbolVisibilityMemo,
  recordRPackageConfig,
  type RNamespaceInfo,
  type RPackageConfig,
} from '../../../../src/core/ingestion/languages/r/package-config.js';
import {
  populateRQualifiedCalls,
  resolveRQualifiedFreeCall,
} from '../../../../src/core/ingestion/languages/r/qualified-call.js';
import { expandRWildcardNames } from '../../../../src/core/ingestion/languages/r/scope-resolver.js';

function parse(src: string, filePath: string): ParsedFile {
  const parsed = extractParsedFile(rProvider, src, filePath);
  if (parsed === undefined) throw new Error(`no ParsedFile for ${filePath}`);
  return parsed;
}

function ns(spec: Partial<RNamespaceInfo>): RNamespaceInfo {
  return {
    hasNamespaceFile: true,
    namedExports: new Set(),
    exportPatterns: [],
    importFrom: [],
    ...spec,
  };
}

function config(
  packages: Record<string, string>,
  namespaces: Record<string, Partial<RNamespaceInfo>>,
  extra: Partial<RPackageConfig> = {},
): RPackageConfig {
  return {
    packages: new Map(Object.entries(packages)),
    namespaceInfoByPackageDir: new Map(
      Object.entries(namespaces).map(([dir, spec]) => [dir, ns(spec)]),
    ),
    truncated: false,
    ...extra,
  };
}

const qualifiedSites = (parsed: ParsedFile) =>
  parsed.referenceSites.filter((s) => s.kind === 'call' && s.rawQualifiedName !== undefined);

describe('rSymbolVisibility', () => {
  const files = [
    parse(
      'shown <- function() 1\nhidden <- function() 2\nnested <- function() { inner <- function() 3 }',
      'p/R/a.R',
    ),
    parse('open <- function() 1', 'q/R/a.R'),
    parse('u1 <- function() 1', 'u/R/a.R'),
  ];
  const cfg = config(
    { p: 'p', q: 'q', u: 'u' },
    { p: { namedExports: new Set(['shown']) }, u: { exportsUnreadable: true } },
  );
  rBuildSymbolVisibilityMemo(files, cfg);

  it('is public for an exported name, private for a readable complete NAMESPACE that omits it', () => {
    expect(rSymbolVisibility(cfg, 'p/R/a.R', 'shown')).toBe('public');
    expect(rSymbolVisibility(cfg, 'p/R/a.R', 'hidden')).toBe('private');
  });

  it('is public for a package without a NAMESPACE file', () => {
    expect(rSymbolVisibility(cfg, 'q/R/a.R', 'open')).toBe('public');
  });

  it('is unknown when the NAMESPACE is unreadable, and for a name the memo does not hold', () => {
    expect(rSymbolVisibility(cfg, 'u/R/a.R', 'u1')).toBe('unknown');
    expect(rSymbolVisibility(cfg, 'p/R/a.R', 'inner')).toBe('unknown');
  });

  it('judges only definitions under a package R/ directory', () => {
    expect(rSymbolVisibility(cfg, 'p/tests/x.R', 'hidden')).toBe('public');
    expect(rSymbolVisibility(cfg, 'scripts/x.R', 'hidden')).toBe('public');
    expect(rSymbolVisibility(null, 'p/R/a.R', 'hidden')).toBe('public');
  });

  it('is unknown for every name of a NAMESPACE package when no memo was built for the config', () => {
    expect(rSymbolVisibility(config({ p: 'p' }, { p: {} }), 'p/R/a.R', 'hidden')).toBe('unknown');
  });
});

describe('rSymbolVisibility under a dropped or cut-short exportPattern()', () => {
  it('is unknown (not private) for a name no pattern matched when a pattern was dropped', () => {
    const files = [parse('abc <- function() 1', 'p/R/a.R')];
    const cfg = config(
      { p: 'p' },
      { p: { droppedExportPatterns: [{ pattern: '\\<x', reason: 'unsupported' }] } },
    );
    rBuildSymbolVisibilityMemo(files, cfg);
    expect(rSymbolVisibility(cfg, 'p/R/a.R', 'abc')).toBe('unknown');
  });
});

describe('visibility is independent of file order, site order and run (determinism)', () => {
  const names = ['pub_a', 'pub_b', 'pub_c', 'pub_d', 'priv_a', 'priv_b', 'priv_c', 'priv_d'];
  const defFiles = (): ParsedFile[] =>
    names.map((n, i) => parse(`${n} <- function() ${i}`, `p/R/${n}.R`));
  const callerSource = [...names, 'missing_reexport']
    .map((n) => `c_${n} <- function() p::${n}()`)
    .join('\n');

  /** A fresh config whose package budget lasts for only a few matcher steps. */
  const freshConfig = (): RPackageConfig => {
    const budget = new SharedWorkBudget(60, 1_000_000);
    const compiled = compileRExportPatternDetailed('^pub', budget);
    if ('reason' in compiled || compiled.matcher === null) throw new Error('pattern not compiled');
    return config(
      { p: 'p' },
      { p: { exportPatterns: [compiled.matcher as RExportMatcher], exportPatternBudget: budget } },
    );
  };

  const outcome = (order: readonly number[], reverseSites: boolean) => {
    const cfg = freshConfig();
    const defs = defFiles();
    let caller = parse(callerSource, 'scripts/use.R');
    if (reverseSites) {
      caller = { ...caller, referenceSites: [...caller.referenceSites].reverse() };
    }
    const files = [...order.map((i) => defs[i]), caller];
    populateRQualifiedCalls(files, { resolutionConfig: cfg });
    const after = files[files.length - 1];
    return {
      visibility: names.map((n) => rSymbolVisibility(cfg, `p/R/${n}.R`, n)),
      bound: qualifiedSites(after)
        .map((s) => s.name)
        .sort(),
    };
  };

  it('gives the same verdicts for permuted and reversed files and sites, across runs', () => {
    const base = outcome([0, 1, 2, 3, 4, 5, 6, 7], false);
    // Guard: the budget really ran out (some name is `unknown`), so order could have mattered.
    expect(base.visibility).toContain('unknown');
    expect(base.visibility).toContain('public');
    for (const order of [
      [7, 6, 5, 4, 3, 2, 1, 0],
      [3, 1, 7, 0, 5, 2, 6, 4],
      [4, 5, 6, 7, 0, 1, 2, 3],
    ]) {
      for (const reverse of [false, true]) {
        expect(outcome(order, reverse)).toEqual(base);
      }
    }
  });
});

describe('populateRQualifiedCalls: no qualified site survives without a precise target', () => {
  const cfgFor = (extra: Partial<RPackageConfig> = {}): RPackageConfig =>
    config(
      { exp: 'exp', oth: 'oth', dup: 'dup' },
      {
        exp: {
          namedExports: new Set(['shown', 'reexp']),
          importFrom: [{ pkg: 'oth', name: 'reexp' }],
        },
        oth: { namedExports: new Set(['reexp']) },
      },
      extra,
    );
  const sources: Record<string, string> = {
    'exp/R/a.R': 'shown <- function() 1\nhidden <- function() 2',
    'oth/R/o.R': 'reexp <- function() 3',
    'dup/R/d1.R': 'twice <- function() 1',
    'dup/R/d2.R': 'twice <- function() 2',
  };
  const caller = [
    'ghost <- function() 0',
    'k1 <- function() exp::shown()',
    'k2 <- function() exp::hidden()',
    'k3 <- function() exp:::hidden()',
    'k4 <- function() exp::ghost()',
    'k5 <- function() exp::reexp()',
    'k6 <- function() dup::twice()',
    'k7 <- function() ext::anything()',
    'k8 <- function() exp:::reexp()',
  ].join('\n');

  const run = (cfg: RPackageConfig | null) => {
    const files = [
      ...Object.entries(sources).map(([p, s]) => parse(s, p)),
      parse(caller, 'scripts/use.R'),
    ];
    populateRQualifiedCalls(files, cfg === null ? {} : { resolutionConfig: cfg });
    return files[files.length - 1];
  };

  it('keeps exactly the sites that have a precise target', () => {
    const after = run(cfgFor());
    const kept = qualifiedSites(after);
    for (const site of kept)
      expect(resolveRQualifiedFreeCall(site, after), site.name).toBeDefined();
    // shown (public), hidden via ::: , reexp via exp (re-export, one origin definition)
    expect(kept.map((s) => `${s.rawQualifiedName}`).sort()).toEqual([
      'exp:::hidden',
      'exp::reexp',
      'exp::shown',
    ]);
    const reexport = kept.find((s) => s.name === 'reexp');
    expect(reexport).toBeDefined();
    expect(resolveRQualifiedFreeCall(reexport as object, after)?.filePath).toBe('oth/R/o.R');
  });

  it('drops every qualified site when locality cannot be decided (no config, truncated discovery)', () => {
    for (const cfg of [null, cfgFor({ truncated: true })]) {
      const after = run(cfg);
      for (const site of qualifiedSites(after)) {
        expect(resolveRQualifiedFreeCall(site, after), site.name).toBeDefined();
      }
    }
    // truncated: `ext` is unknown, `exp`/`dup` are still local through the config.
    expect(qualifiedSites(run(cfgFor({ truncated: true }))).map((s) => s.name)).not.toContain(
      'anything',
    );
  });

  it('a caller inside the package tree reaches a private name through ::, one outside does not', () => {
    const cfg = cfgFor();
    const files = [
      ...Object.entries(sources).map(([p, s]) => parse(s, p)),
      parse('inside <- function() exp::hidden()', 'exp/tests/testthat/test-a.R'),
      parse('outside <- function() exp::hidden()', 'scripts/use.R'),
    ];
    populateRQualifiedCalls(files, { resolutionConfig: cfg });
    expect(qualifiedSites(files[files.length - 2])).toHaveLength(1);
    expect(qualifiedSites(files[files.length - 1])).toHaveLength(0);
  });

  it('does not resolve a re-export whose origin is an external package', () => {
    const cfg = cfgFor();
    cfg.namespaceInfoByPackageDir.set(
      'exp',
      ns({ namedExports: new Set(['reexp']), importFrom: [{ pkg: 'ext', name: 'reexp' }] }),
    );
    const files = [
      ...Object.entries(sources).map(([p, s]) => parse(s, p)),
      parse('k <- function() exp::reexp()', 'scripts/use.R'),
    ];
    populateRQualifiedCalls(files, { resolutionConfig: cfg });
    expect(qualifiedSites(files[files.length - 1])).toHaveLength(0);
  });
});

describe('isRGlobalNameFallbackPlausible: proven-private veto', () => {
  const files = [
    parse('shown <- function() 1\nhidden <- function() 2', 'exp/R/a.R'),
    parse('u1 <- function() 1', 'unr/R/a.R'),
  ];
  const cfg = config(
    { exp: 'exp', unr: 'unr' },
    { exp: { namedExports: new Set(['shown']) }, unr: { exportsUnreadable: true } },
  );
  rBuildSymbolVisibilityMemo(files, cfg);
  const verdict = (name: string, candidateFile: string, callerFile: string): boolean =>
    isRGlobalNameFallbackPlausible({
      callerParsed: { filePath: callerFile },
      candidate: { filePath: candidateFile, type: 'Function' },
      resolutionConfig: cfg,
      site: { name },
    });

  it('vetoes a private candidate for a caller outside the package tree', () => {
    expect(verdict('hidden', 'exp/R/a.R', 'scripts/s.R')).toBe(false);
    expect(verdict('hidden', 'exp/R/a.R', 'other/R/b.R')).toBe(false);
  });

  it('allows a private candidate for callers inside the tree, including tests/ and inst/', () => {
    expect(verdict('hidden', 'exp/R/a.R', 'exp/R/b.R')).toBe(true);
    expect(verdict('hidden', 'exp/R/a.R', 'exp/tests/testthat/test-a.R')).toBe(true);
    expect(verdict('hidden', 'exp/R/a.R', 'exp/inst/x.R')).toBe(true);
  });

  it('allows an exported name and an unknown-visibility name (a guess is vetoed only when impossible)', () => {
    expect(verdict('shown', 'exp/R/a.R', 'scripts/s.R')).toBe(true);
    expect(verdict('u1', 'unr/R/a.R', 'scripts/s.R')).toBe(true);
  });

  it('does not judge a candidate that is not a function or class', () => {
    expect(
      isRGlobalNameFallbackPlausible({
        callerParsed: { filePath: 'scripts/s.R' },
        candidate: { filePath: 'exp/R/a.R', type: 'Method' },
        resolutionConfig: cfg,
        site: { name: 'hidden' },
      }),
    ).toBe(true);
  });
});

describe('expandRWildcardNames: library() brings in exports only', () => {
  const target = parse('shown <- function() 1\nhidden <- function() 2', 'exp/R/a.R');
  const open = parse('a <- function() 1\nb <- function() 2', 'nons/R/a.R');
  const cfg = config({ exp: 'exp', nons: 'nons' }, { exp: { namedExports: new Set(['shown']) } });
  rBuildSymbolVisibilityMemo([target, open], cfg);
  recordRPackageConfig([target, open], cfg);

  it('keeps exported names, drops the rest', () => {
    expect([...expandRWildcardNames(target.moduleScope, [target])]).toEqual(['shown']);
  });

  it('keeps every name of a package without a NAMESPACE', () => {
    expect([...expandRWildcardNames(open.moduleScope, [open])].sort()).toEqual(['a', 'b']);
  });

  it('filters nothing when no config was recorded for the file (hand-built input)', () => {
    const bare = parse('shown <- function() 1\nhidden <- function() 2', 'exp/R/a.R');
    expect([...expandRWildcardNames(bare.moduleScope, [bare])].sort()).toEqual(['hidden', 'shown']);
  });
});

describe('rEnclosingPackageDir', () => {
  it('is the longest package directory that is a path prefix, so tests/ and inst/ are inside', () => {
    const cfg = config({ outer: 'outer', inner: 'outer/inner' }, { outer: {}, 'outer/inner': {} });
    expect(rEnclosingPackageDir('outer/R/a.R', cfg)).toBe('outer');
    expect(rEnclosingPackageDir('outer/tests/testthat/t.R', cfg)).toBe('outer');
    expect(rEnclosingPackageDir('outer/inst/x.R', cfg)).toBe('outer');
    expect(rEnclosingPackageDir('outer/inner/R/a.R', cfg)).toBe('outer/inner');
    expect(rEnclosingPackageDir('outer/inner/tests/t.R', cfg)).toBe('outer/inner');
    expect(rEnclosingPackageDir('outerx/R/a.R', cfg)).toBeUndefined();
    expect(rEnclosingPackageDir('scripts/s.R', cfg)).toBeUndefined();
  });

  it('claims every file of a root-level package that no nested package owns', () => {
    const cfg = config({ root: '', sub: 'sub' }, { '': {} });
    expect(rEnclosingPackageDir('scripts/s.R', cfg)).toBe('');
    expect(rEnclosingPackageDir('R/a.R', cfg)).toBe('');
    expect(rEnclosingPackageDir('sub/R/a.R', cfg)).toBe('sub');
  });

  it('is undefined without a config', () => {
    expect(rEnclosingPackageDir('R/a.R', null)).toBeUndefined();
  });
});

describe('qualifier operator and re-export origin', () => {
  it.each([
    ['pkg::f', '::'],
    ['pkg:::f', ':::'],
    ['pkg ::: f', ':::'],
    ['"pkg"::f', '::'],
    ['f', undefined],
  ])('reads the operator of %s', (raw, op) => {
    expect(parseRQualifierOperator(raw)).toBe(op);
  });

  it('takes the last importFrom entry for the name, and ignores a self-import', () => {
    const cfg = config(
      { a: 'a' },
      {
        a: {
          importFrom: [
            { pkg: 'x', name: 'f' },
            { pkg: 'y', name: 'f' },
            { pkg: 'a', name: 'g' },
          ],
        },
      },
    );
    expect(rReexportOrigin(cfg, 'a', 'a', 'f')).toBe('y');
    expect(rReexportOrigin(cfg, 'a', 'a', 'g')).toBeUndefined();
    expect(rReexportOrigin(cfg, 'a', 'a', 'h')).toBeUndefined();
    expect(rReexportOrigin(cfg, 'nodir', 'a', 'f')).toBeUndefined();
  });
});
