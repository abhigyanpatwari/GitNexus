import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseRNamespaceImportFrom } from '../../src/core/ingestion/languages/r/namespace-imports.js';
import { loadRPackageConfig } from '../../src/core/ingestion/language-config.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

// `parseRNamespaceImportFrom` is pure and package-blind: it returns every
// `importFrom()` pair in file order. Own-package drop, last-wins and external
// skipping are consumer policy (C4), not parser behaviour.
describe('parseRNamespaceImportFrom', () => {
  it('parses a single-line directive with several names', () => {
    expect(parseRNamespaceImportFrom('importFrom(dplyr, mutate, filter)\n')).toEqual([
      { pkg: 'dplyr', name: 'mutate' },
      { pkg: 'dplyr', name: 'filter' },
    ]);
  });

  it('parses a wrapped multi-line directive with leading/trailing commas and blank lines', () => {
    const src = [
      'importFrom(scorelib,',
      '  normalise_scores,',
      '',
      '  rank_scores,',
      '  clip_scores,',
      '  )',
      'importFrom(,tidyr,',
      '  pivot_longer,)',
    ].join('\n');
    expect(parseRNamespaceImportFrom(src)).toEqual([
      { pkg: 'scorelib', name: 'normalise_scores' },
      { pkg: 'scorelib', name: 'rank_scores' },
      { pkg: 'scorelib', name: 'clip_scores' },
    ]);
  });

  it('parses a 6-line wrapped directive', () => {
    const src = 'importFrom(\n  scorelib,\n  a,\n  b,\n  c,\n  d\n)\n';
    expect(parseRNamespaceImportFrom(src)).toEqual([
      { pkg: 'scorelib', name: 'a' },
      { pkg: 'scorelib', name: 'b' },
      { pkg: 'scorelib', name: 'c' },
      { pkg: 'scorelib', name: 'd' },
    ]);
  });

  it('accepts bare, double-quoted, single-quoted and backticked names', () => {
    const src = `importFrom("dplyr", "mutate", 'filter', \`select\`, bare)\nimportFrom(magrittr, \`%>%\`, .data)\n`;
    expect(parseRNamespaceImportFrom(src)).toEqual([
      { pkg: 'dplyr', name: 'mutate' },
      { pkg: 'dplyr', name: 'filter' },
      { pkg: 'dplyr', name: 'select' },
      { pkg: 'dplyr', name: 'bare' },
      { pkg: 'magrittr', name: '%>%' },
      { pkg: 'magrittr', name: '.data' },
    ]);
  });

  it('strips backticks and quotes from the package name too', () => {
    expect(parseRNamespaceImportFrom('importFrom(`pkg.a`, x)\nimportFrom("pkg-b", y)')).toEqual([
      { pkg: 'pkg.a', name: 'x' },
      { pkg: 'pkg-b', name: 'y' },
    ]);
  });

  it('tolerates whitespace between the directive head and the parenthesis', () => {
    expect(parseRNamespaceImportFrom('importFrom (dplyr, mutate)')).toEqual([
      { pkg: 'dplyr', name: 'mutate' },
    ]);
  });

  it('strips comments: full-line, inline, and inside a wrapped directive', () => {
    const src = [
      '# importFrom(ignored, gone)',
      'importFrom(dplyr, mutate) # trailing comment importFrom(x, y)',
      'importFrom(scorelib,  # why',
      '  rank_scores)',
    ].join('\n');
    expect(parseRNamespaceImportFrom(src)).toEqual([
      { pkg: 'dplyr', name: 'mutate' },
      { pkg: 'scorelib', name: 'rank_scores' },
    ]);
  });

  it('keeps a # inside a quoted name', () => {
    expect(parseRNamespaceImportFrom('importFrom(pkg, "a#b", c)')).toEqual([
      { pkg: 'pkg', name: 'a#b' },
      { pkg: 'pkg', name: 'c' },
    ]);
  });

  it('is CRLF-safe', () => {
    const src =
      'importFrom(dplyr,\r\n  mutate,\r\n  filter)\r\nimportFrom(tidyr, pivot_longer)\r\n';
    expect(parseRNamespaceImportFrom(src)).toEqual([
      { pkg: 'dplyr', name: 'mutate' },
      { pkg: 'dplyr', name: 'filter' },
      { pkg: 'tidyr', name: 'pivot_longer' },
    ]);
  });

  it('ignores import(), importClassesFrom(), importMethodsFrom(), S3method(), export*(), useDynLib()', () => {
    const src = [
      'import(dplyr)',
      'importClassesFrom(methods, setClass)',
      'importMethodsFrom(methods, show)',
      'S3method(print, thing)',
      'export(a, b)',
      'exportPattern("^[a-z]")',
      'exportClasses(K)',
      'useDynLib(pkg, .registration = TRUE)',
      'importFrom(dplyr, mutate)',
    ].join('\n');
    expect(parseRNamespaceImportFrom(src)).toEqual([{ pkg: 'dplyr', name: 'mutate' }]);
  });

  it('does not extract an importFrom nested inside another directive', () => {
    expect(parseRNamespaceImportFrom('export(importFrom(a, b))')).toEqual([]);
  });

  it('ignores conditional importFrom (if / else, with or without braces)', () => {
    const src = [
      'if (getRversion() >= "4.0.0") importFrom(newpkg, fn)',
      'if (cond) {',
      '  importFrom(bracedpkg, fn2)',
      '} else {',
      '  importFrom(otherpkg, fn3)',
      '}',
      'if (cond) importFrom(a, b) else importFrom(c, d)',
      'importFrom(dplyr, mutate)',
    ].join('\n');
    expect(parseRNamespaceImportFrom(src)).toEqual([{ pkg: 'dplyr', name: 'mutate' }]);
  });

  it('returns a self-import entry like any other (dropping it is the consumer job)', () => {
    expect(parseRNamespaceImportFrom('importFrom(analytics, helper)\n')).toEqual([
      { pkg: 'analytics', name: 'helper' },
    ]);
  });

  it('preserves file order and keeps a duplicate symbol from two packages', () => {
    const src = 'importFrom(pkga, filter)\nimportFrom(dplyr, mutate)\nimportFrom(pkgb, filter)\n';
    expect(parseRNamespaceImportFrom(src)).toEqual([
      { pkg: 'pkga', name: 'filter' },
      { pkg: 'dplyr', name: 'mutate' },
      { pkg: 'pkgb', name: 'filter' },
    ]);
  });

  it('keeps a repeated identical entry (no dedup in the parser)', () => {
    expect(parseRNamespaceImportFrom('importFrom(a, f)\nimportFrom(a, f)')).toHaveLength(2);
  });

  it('yields nothing for a directive with a package but no names, or no arguments', () => {
    expect(parseRNamespaceImportFrom('importFrom(dplyr)\nimportFrom()\nimportFrom(,)')).toEqual([]);
  });

  it('never throws on empty, whitespace-only, unbalanced or garbage input', () => {
    for (const src of [
      '',
      '   \n\t\n',
      'importFrom(dplyr, mutate',
      'importFrom(dplyr, "mutate)',
      'importFrom(',
      'importFrom',
      ')))((( ,,, """ \'\'\' ```',
      '\u0000\u0001 importFrom(a, b',
      '{ { {',
    ]) {
      expect(() => parseRNamespaceImportFrom(src)).not.toThrow();
      expect(parseRNamespaceImportFrom(src)).toEqual([]);
    }
  });

  it('keeps directives parsed before an unbalanced one', () => {
    expect(parseRNamespaceImportFrom('importFrom(dplyr, mutate)\nimportFrom(broken, x')).toEqual([
      { pkg: 'dplyr', name: 'mutate' },
    ]);
  });

  it('skips a stray quoted string at top level without misreading its contents', () => {
    expect(parseRNamespaceImportFrom('"importFrom(a, b)"\nimportFrom(c, d)')).toEqual([
      { pkg: 'c', name: 'd' },
    ]);
  });

  it('ignores non-simple arguments (named / nested) but keeps the simple ones', () => {
    expect(parseRNamespaceImportFrom('importFrom(pkg, x = y, good, f(z))')).toEqual([
      { pkg: 'pkg', name: 'good' },
    ]);
  });
});

describe('loadRPackageConfig -> RNamespaceInfo.importFrom', () => {
  const pool = createTempDirPool('gn-r-ns-');

  it('populates importFrom (all entries, file order) alongside the existing export fields', async () => {
    const root = pool.dir();
    const pkgDir = path.join(root, 'analytics');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'DESCRIPTION'), 'Package: analytics\nVersion: 0.0.1\n');
    fs.writeFileSync(
      path.join(pkgDir, 'NAMESPACE'),
      'export(run_all)\nimportFrom(scorelib,\n  rank_scores,\n  clip_scores)\nimportFrom(analytics, helper)\n',
    );
    const config = await loadRPackageConfig(root);
    const info = config?.namespaceInfoByPackageDir.get('analytics');
    expect(info?.hasNamespaceFile).toBe(true);
    expect([...(info?.namedExports ?? [])]).toEqual(['run_all']);
    expect(info?.importFrom).toEqual([
      { pkg: 'scorelib', name: 'rank_scores' },
      { pkg: 'scorelib', name: 'clip_scores' },
      { pkg: 'analytics', name: 'helper' },
    ]);
  });

  it('leaves no namespace entry when the package has no NAMESPACE file', async () => {
    const root = pool.dir();
    const pkgDir = path.join(root, 'plainpkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'DESCRIPTION'), 'Package: plainpkg\n');
    const config = await loadRPackageConfig(root);
    expect(config?.packages.get('plainpkg')).toBe('plainpkg');
    expect(config?.namespaceInfoByPackageDir.has('plainpkg')).toBe(false);
  });

  it('gives an empty importFrom for a NAMESPACE without importFrom directives', async () => {
    const root = pool.dir();
    fs.writeFileSync(path.join(root, 'DESCRIPTION'), 'Package: rootpkg\n');
    fs.writeFileSync(path.join(root, 'NAMESPACE'), 'export(f)\n');
    const config = await loadRPackageConfig(root);
    expect(config?.namespaceInfoByPackageDir.get('')?.importFrom).toEqual([]);
  });
});
