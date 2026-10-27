/**
 * Locks the prepared-copy path map and the `gitnexus-shared` aliases (KTD8): relocated
 * shared sources translate back to `gitnexus-shared/src/...`, `gitnexus/src/...` is the
 * identity, anything else is rejected, and one alias exists per package `exports` key.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PATH_MAP,
  buildPathMap,
  deriveSharedAliases,
  parseSharedPackageJson,
  toPreparedPath,
  toRepoPath,
  toRepoPathFromPackageDir,
} from '../../../tools/mutation/prepare/path-map.js';

const RELOCATED_SCHEMA = 'gitnexus/relocated/gitnexus-shared/src/lbug/schema-constants.ts';
const SHARED_DIR = path.join(path.sep, 'prepared', 'gitnexus', 'relocated', 'gitnexus-shared');

describe('toRepoPath', () => {
  it('translates a relocated shared path back to gitnexus-shared/src', () => {
    expect(toRepoPath(RELOCATED_SCHEMA)).toBe('gitnexus-shared/src/lbug/schema-constants.ts');
  });

  it('leaves a gitnexus/src path unchanged', () => {
    expect(toRepoPath('gitnexus/src/core/ingestion/type-extractors/shared.ts')).toBe(
      'gitnexus/src/core/ingestion/type-extractors/shared.ts',
    );
  });

  it('accepts Windows separators and a leading ./', () => {
    expect(toRepoPath('.\\gitnexus\\relocated\\gitnexus-shared\\src\\index.ts')).toBe(
      'gitnexus-shared/src/index.ts',
    );
  });

  it.each([
    ['a test file', 'gitnexus/test/unit/schema.test.ts'],
    ['an unrelocated shared path', 'gitnexus-shared/src/index.ts'],
    ['a parent-relative path', '../gitnexus/src/index.ts'],
    ['a path that climbs out of src', 'gitnexus/src/../../etc/passwd'],
    ['an absolute path', '/abs/gitnexus/src/index.ts'],
    ['the src root itself', 'gitnexus/src'],
  ])('rejects %s', (_label, input) => {
    expect(() => toRepoPath(input)).toThrow(/outside the mapped roots|not a relative path/);
  });
});

describe('toPreparedPath', () => {
  it('maps gitnexus-shared/src into the relocated directory', () => {
    expect(toPreparedPath('gitnexus-shared/src/lbug/schema-constants.ts')).toBe(RELOCATED_SCHEMA);
  });

  it('round-trips a gitnexus/src path', () => {
    expect(toRepoPath(toPreparedPath('gitnexus/src/core/lbug/schema.ts'))).toBe(
      'gitnexus/src/core/lbug/schema.ts',
    );
  });

  it('rejects a path outside both roots', () => {
    expect(() => toPreparedPath('gitnexus/test/unit/schema.test.ts')).toThrow(
      /outside the mapped roots/,
    );
  });
});

describe('toRepoPathFromPackageDir', () => {
  const sandbox = path.join(path.sep, 'tmp', 'sandbox-1');

  it('maps an absolute relocated path under a sandbox back to gitnexus-shared/src', () => {
    expect(
      toRepoPathFromPackageDir(
        sandbox,
        path.join(sandbox, 'relocated', 'gitnexus-shared', 'src', 'lbug', 'schema-constants.ts'),
      ),
    ).toBe('gitnexus-shared/src/lbug/schema-constants.ts');
  });

  it('rejects an absolute path outside the package directory', () => {
    expect(() =>
      toRepoPathFromPackageDir(sandbox, path.join(path.sep, 'tmp', 'other', 'src', 'a.ts')),
    ).toThrow(/outside the mapped roots|not a relative path/);
  });
});

describe('buildPathMap: extra roots for mutation fixture projects', () => {
  const FIXTURE = 'gitnexus/test/fixtures/mutation-conformance';
  const FIXTURE_FILE = `${FIXTURE}/src/static-table.ts`;
  const map = buildPathMap([FIXTURE]);

  it('is the default map when no extra root is given', () => {
    expect(buildPathMap()).toEqual(PATH_MAP);
  });

  it('maps a file under an extra root to itself, in both directions', () => {
    expect([toPreparedPath(FIXTURE_FILE, map), toRepoPath(FIXTURE_FILE, map)]).toEqual([
      FIXTURE_FILE,
      FIXTURE_FILE,
    ]);
  });

  it('maps an absolute sandbox path under an extra root back to its repo path', () => {
    const sandbox = path.join(path.sep, 'tmp', 'sandbox-2');
    const absolute = path.join(sandbox, 'test', 'fixtures', 'mutation-conformance', 'src', 'a.ts');
    expect(toRepoPathFromPackageDir(sandbox, absolute, map)).toBe(`${FIXTURE}/src/a.ts`);
  });

  it('keeps the default roots in an extended map', () => {
    expect(toPreparedPath('gitnexus-shared/src/lbug/schema-constants.ts', map)).toBe(
      RELOCATED_SCHEMA,
    );
  });

  it('still rejects the fixture path under the default map', () => {
    expect(() => toPreparedPath(FIXTURE_FILE)).toThrow(/outside the mapped roots/);
  });

  it('still rejects paths outside every root under an extended map', () => {
    expect(() => toPreparedPath('gitnexus/test/unit/schema.test.ts', map)).toThrow(
      /outside the mapped roots/,
    );
  });

  it('accepts a trailing slash, Windows separators and a repeated root once', () => {
    expect(buildPathMap([`${FIXTURE}/`, 'gitnexus\\test\\fixtures\\mutation-conformance'])).toEqual(
      map,
    );
  });

  it.each([
    ['another test directory', 'gitnexus/test/unit'],
    ['a fixture that is not a mutation fixture', 'gitnexus/test/fixtures/lang-resolution'],
    ['a file inside a mutation fixture', 'gitnexus/test/fixtures/mutation-x/src'],
    ['the fixtures directory itself', 'gitnexus/test/fixtures'],
    ['a production root', 'gitnexus/src'],
    ['a parent-relative path', '../gitnexus/test/fixtures/mutation-x'],
    ['an absolute path', '/gitnexus/test/fixtures/mutation-x'],
  ])('rejects %s as an extra root', (_label, root) => {
    expect(() => buildPathMap([root])).toThrow(/path map/);
  });
});

describe('deriveSharedAliases', () => {
  it('creates exactly one alias per key of the gitnexus-shared exports map', () => {
    const text = readFileSync(
      new URL('../../../../gitnexus-shared/package.json', import.meta.url),
      'utf8',
    );
    const { exports: exportsMap }: { exports: Record<string, unknown> } = JSON.parse(text);
    const aliases = deriveSharedAliases(parseSharedPackageJson(text), SHARED_DIR);

    expect(aliases.map((a) => a.specifier)).toEqual(
      // '.' -> 'gitnexus-shared', './test-helpers' -> 'gitnexus-shared/test-helpers'
      Object.keys(exportsMap).map((key) => `gitnexus-shared${key.slice(1)}`),
    );
  });

  it('points each alias at the matching source file under the relocated src', () => {
    const aliases = deriveSharedAliases(
      {
        name: 'gitnexus-shared',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './test-helpers': {
            types: './dist/test-helpers.d.ts',
            default: './dist/test-helpers.js',
          },
        },
      },
      SHARED_DIR,
    );

    expect(aliases.map(({ specifier, replacement }) => ({ specifier, replacement }))).toEqual([
      { specifier: 'gitnexus-shared', replacement: path.join(SHARED_DIR, 'src', 'index.ts') },
      {
        specifier: 'gitnexus-shared/test-helpers',
        replacement: path.join(SHARED_DIR, 'src', 'test-helpers.ts'),
      },
    ]);
  });

  it('anchors each alias so it matches only its own specifier', () => {
    const [root] = deriveSharedAliases(
      { name: 'gitnexus-shared', exports: { '.': './dist/index.js' } },
      SHARED_DIR,
    );

    expect(
      [
        'gitnexus-shared',
        'gitnexus-shared/test-helpers',
        'gitnexus-shared-x',
        'x/gitnexus-shared',
      ].map((specifier) => root.find.test(specifier)),
    ).toEqual([true, false, false, false]);
  });

  it.each([
    ['a wildcard export', { './*': './dist/*.js' }],
    ['a target outside dist', { '.': './lib/index.js' }],
    ['a target without a default condition', { '.': { types: './dist/index.d.ts' } }],
    ['a non-subpath key', { import: './dist/index.js' }],
  ])('rejects %s', (_label, exportsMap) => {
    expect(() =>
      deriveSharedAliases({ name: 'gitnexus-shared', exports: exportsMap }, SHARED_DIR),
    ).toThrow(/gitnexus-shared exports/);
  });
});
