/**
 * Locks the scope-file contract between the caller of a mutation run and
 * tools/mutation/vitest.mutation.config.ts (KTD9): a JSON object whose `testFiles` lists
 * package-relative test paths.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUTATION_SCOPE_ENV,
  parseMutationScope,
  resolveMutationScopePath,
} from '../../../tools/mutation/scope-file.js';

describe('parseMutationScope', () => {
  it('returns the listed test files in order', () => {
    expect(
      parseMutationScope(
        JSON.stringify({ testFiles: ['test/unit/schema.test.ts', 'test/unit/a/b.test.ts'] }),
      ),
    ).toEqual({ testFiles: ['test/unit/schema.test.ts', 'test/unit/a/b.test.ts'] });
  });

  it.each([
    ['invalid JSON', '{', /not valid JSON/],
    ['a non-object', '[]', /must be a JSON object/],
    ['a missing testFiles', '{}', /testFiles must be a non-empty array/],
    ['an empty testFiles', '{"testFiles":[]}', /testFiles must be a non-empty array/],
    ['a non-string entry', '{"testFiles":[1]}', /must be a string/],
    ['an absolute path', '{"testFiles":["/abs/x.test.ts"]}', /package-relative/],
    ['a parent segment', '{"testFiles":["test/../../x.test.ts"]}', /package-relative/],
    ['a backslash path', '{"testFiles":["test\\\\unit\\\\x.test.ts"]}', /package-relative/],
    ['a duplicate entry', '{"testFiles":["t/x.test.ts","t/x.test.ts"]}', /listed twice/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseMutationScope(text)).toThrow(message);
  });
});

describe('resolveMutationScopePath', () => {
  const packageDir = path.join(path.sep, 'prepared', 'gitnexus');

  it('resolves a relative scope path against the package directory', () => {
    expect(resolveMutationScopePath({ [MUTATION_SCOPE_ENV]: 'scope.json' }, packageDir)).toBe(
      path.join(packageDir, 'scope.json'),
    );
  });

  it('keeps an absolute scope path', () => {
    const absolute = path.join(path.sep, 'runs', 'scope.json');

    expect(resolveMutationScopePath({ [MUTATION_SCOPE_ENV]: absolute }, packageDir)).toBe(absolute);
  });

  it('fails with the variable name when no scope file is set', () => {
    expect(() => resolveMutationScopePath({}, packageDir)).toThrow(MUTATION_SCOPE_ENV);
  });
});
