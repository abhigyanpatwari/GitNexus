/**
 * Locks how the prepare step resolves its `--mutate` files: canonical repo paths, each once,
 * through the default path map, and through an extended map (a mutation fixture project's root,
 * U4) only when the caller passes one.
 */
import { describe, expect, it } from 'vitest';
import { canonicalMutatePaths } from '../../../tools/mutation/prepare/prepare.js';
import { buildPathMap } from '../../../tools/mutation/prepare/path-map.js';

const FIXTURE_ROOT = 'gitnexus/test/fixtures/mutation-conformance';
const FIXTURE_FILE = `${FIXTURE_ROOT}/src/runtime.ts`;

describe('canonicalMutatePaths', () => {
  it('canonicalises separators and a leading ./ and lists each file once', () => {
    expect(
      canonicalMutatePaths([
        './gitnexus-shared/src/lbug/schema-constants.ts',
        'gitnexus-shared\\src\\lbug\\schema-constants.ts',
        'gitnexus/src/core/lbug/schema.ts',
      ]),
    ).toEqual(['gitnexus-shared/src/lbug/schema-constants.ts', 'gitnexus/src/core/lbug/schema.ts']);
  });

  it('accepts a fixture file under the extended path map', () => {
    expect(canonicalMutatePaths([`./${FIXTURE_FILE}`], buildPathMap([FIXTURE_ROOT]))).toEqual([
      FIXTURE_FILE,
    ]);
  });

  it.each([
    ['a fixture file under the default map', FIXTURE_FILE, /outside the mapped roots/],
    ['a declaration file', 'gitnexus/src/types.d.ts', /not a \.ts source file/],
    ['a non-TypeScript file', 'gitnexus/src/index.js', /not a \.ts source file/],
  ])('rejects %s', (_label, file, message) => {
    expect(() => canonicalMutatePaths([file])).toThrow(message);
  });
});
