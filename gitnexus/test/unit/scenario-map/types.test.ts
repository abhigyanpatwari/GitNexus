/**
 * Locks the scenario map's one production-file predicate (KTD7) and its path helpers:
 * `gitnexus/src/` and `gitnexus-shared/src/` sources are production, tool, test and fixture
 * case files are not, and a mutation fixture's `src/` modules count only when the fixture root is
 * passed as an extra root (`controls` mode).
 */
import { describe, expect, it } from 'vitest';
import {
  extraRootsOf,
  fromPackagePath,
  isProductionFile,
  productionRoots,
  toPackagePath,
} from '../../../tools/scenario-map/types.js';

const FIXTURE = 'gitnexus/test/fixtures/mutation-scenario-map';
const CONTROLS = extraRootsOf({ kind: 'controls', fixtureRoot: FIXTURE });
const NORMAL = extraRootsOf({ kind: 'normal' });

describe('isProductionFile', () => {
  it.each([
    ['a gitnexus/src module', 'gitnexus/src/a.ts', NORMAL, true],
    [
      'a gitnexus-shared/src module (relocated when prepared)',
      'gitnexus-shared/src/b.ts',
      NORMAL,
      true,
    ],
    ['a nested gitnexus/src module', 'gitnexus/src/core/lbug/schema.ts', NORMAL, true],
    ['a tool module', 'gitnexus/tools/x.ts', NORMAL, false],
    ['a unit test', 'gitnexus/test/unit/y.test.ts', NORMAL, false],
    ['a fixture case file in controls mode', `${FIXTURE}/rows.case.ts`, CONTROLS, false],
    ['a fixture src module in normal mode', `${FIXTURE}/src/rows.ts`, NORMAL, false],
    ['a fixture src module in controls mode', `${FIXTURE}/src/rows.ts`, CONTROLS, true],
    ['a fixture config in controls mode', `${FIXTURE}/vitest.config.ts`, CONTROLS, false],
    ['a declaration file under src', 'gitnexus/src/types.d.ts', NORMAL, false],
    ['a test-named file under src', 'gitnexus/src/a.test.ts', NORMAL, false],
    ['a non-TypeScript file under src', 'gitnexus/src/README.md', NORMAL, false],
    ['a script', 'gitnexus/scripts/run.ts', NORMAL, false],
    ['a Windows-separated src path', 'gitnexus\\src\\a.ts', NORMAL, true],
  ])('classifies %s', (_label, repoPath, extraRoots, expected) => {
    expect(isProductionFile(repoPath, extraRoots)).toBe(expected);
  });

  it.each([
    ['an absolute path', '/abs/gitnexus/src/a.ts'],
    ['a parent-relative path', '../gitnexus/src/a.ts'],
  ])('throws on %s instead of answering false', (_label, repoPath) => {
    expect(() => isProductionFile(repoPath)).toThrow(/not a relative path/);
  });

  it('rejects an extra root that is not a mutation fixture directory', () => {
    expect(() => productionRoots(['gitnexus/tools'])).toThrow(/not a mutation fixture directory/);
  });

  it('lists the path-map roots, plus the src/ subtree of each extra root', () => {
    expect(productionRoots(CONTROLS)).toEqual([
      'gitnexus-shared/src/',
      'gitnexus/src/',
      `${FIXTURE}/src/`,
    ]);
  });
});

describe('package paths', () => {
  it('converts a repo path under gitnexus/ to a package path and back', () => {
    expect(toPackagePath('gitnexus/test/unit/a.test.ts')).toBe('test/unit/a.test.ts');
    expect(fromPackagePath('test/unit/a.test.ts')).toBe('gitnexus/test/unit/a.test.ts');
  });

  it('throws for a repo path outside gitnexus/', () => {
    expect(() => toPackagePath('gitnexus-shared/src/b.ts')).toThrow(/not under gitnexus\//);
  });
});
