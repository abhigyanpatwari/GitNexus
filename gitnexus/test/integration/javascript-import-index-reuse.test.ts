/**
 * Production-path regression guard for the JavaScript import-resolution index
 * (#2910).
 *
 * `makeJsResolveImportTarget`'s `PassCache` was the TypeScript one minus its
 * `index` field, so every JavaScript import reached `suffixResolve` with
 * `index === undefined` and took the linear-`findIndex` fallback: one pass over
 * `normalizedFileList` per path part per extension, ~39 extensions. 6448.9 µs
 * per import at 2000 files and 25972.6 µs at 8000 — 4.12x the per-import cost
 * for 4x the files, which is O(imports × files) — against 25.0 / 27.0 µs for
 * TypeScript over the identical corpus. With the index it is 28.5 / 27.4 µs and
 * the scaling factor is 1.09x.
 *
 * ## Why the existing guards were blind to it
 *
 * `CountingSet` counts traversals of the SET, and this scan walked the array
 * the adapter had already materialized from it (`test/helpers/counting-file-set.ts`
 * says so under "What it does NOT see"). The pass cache was reused correctly,
 * so the traversal count read 2 with the defect and reads 2 without it — the
 * sixteen-language contract test scored `javascript` a clean pass throughout.
 *
 * So the arm that would have caught this is not a count of Set traversals but
 * `resolves a repo-root module by bare specifier` below: without an index a
 * repo-root file is unreachable through this leg, because the scan tests
 * `endsWith('/' + suffix)` and a root-level path has no `/`. It is a behaviour
 * assertion, it is deterministic, and it fails the moment `index` leaves the
 * cache. The direct instrument — counting entries into `suffixResolve`'s linear
 * branch, with the pre-index adapter as its control — lives beside the
 * differential in `test/unit/scope-resolution/javascript-import-target-parity.test.ts`.
 *
 * ## What the traversal counts here do guard
 *
 * Resolution reaches the cache through `javascriptScopeResolver.resolveImportTarget`
 * — the orchestrator adapter — which must pass the Set THROUGH: a defensive
 * `new Set(allFilePaths)` hands a fresh `WeakMap` key per import and restores
 * the per-import rebuild (PR #1918 review P1). Two traversals per file set, not
 * one: the adapter materializes `allFileList` and then keeps one mutable copy
 * of the Set, because `TsResolveContext.allFilePaths` is a `Set`, not a
 * `ReadonlySet`.
 *
 * The counts are paired with result assertions on purpose: a count of 2 is
 * equally true of an adapter that has stopped resolving anything at all.
 */
import { describe, it, expect } from 'vitest';
import { javascriptScopeResolver } from '../../src/core/ingestion/languages/javascript/scope-resolver.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = javascriptScopeResolver;

const FROM_FILE = 'src/main.js';

/**
 * A synthetic CommonJS/ESM app covering the legs the resolver takes: a relative
 * import answered by exact `Set.has`, a bare specifier answered by path suffix,
 * a `node_modules` package, a directory `index.js`, and `config.js` at the repo
 * root — the one shape only the index can reach.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`src/components/Widget${String(i).padStart(5, '0')}.js`);
  }
  files.push('src/util.js');
  files.push('src/models/index.js');
  files.push('lib/esm.mjs');
  files.push('node_modules/dep/index.js');
  files.push('config.js');
  files.push('bootstrap.cjs');
  files.push(FROM_FILE);
  return new CountingSet(files);
}

describe('JavaScript import resolution — index reuse across imports (#2910)', () => {
  it('builds the pass cache once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // A relative hit, a bare-specifier suffix hit, a repo-root hit, and a
      // bare specifier that misses. The miss is the expensive case: it runs
      // every path part × every extension before returning null, which is the
      // loop that used to scan the whole file list each time round.
      resolved.push(resolveImportTarget('./util', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget('src/models', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget('config', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget(`@vendor/ghost${i}/deep`, FROM_FILE, files, undefined));
    }

    // Two: `Array.from(allFilePaths)` and the one mutable `Set` copy the
    // resolver context requires. Both happen once per file set.
    expect(files.scans).toBe(2);

    // Paired result assertions — a count of 2 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBe('src/util.js');
    expect(resolved[1]).toBe('src/models/index.js');
    expect(resolved[2]).toBe('config.js');
    expect(resolved[3]).toBeNull();
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(20),
      targetRaw: 'src/models',
      fromFile: FROM_FILE,
      resolutionConfig: undefined,
      expected: 'src/models/index.js',
      expectedScans: 2,
    });
  });

  /**
   * The per-file-set index and `resolveCache` must not become global. The arm
   * above cannot see that: `expectDistinctFileSetsGetOwnIndex` builds two
   * IDENTICAL corpora, so a stale answer carried across them is also the right
   * answer, and only its traversal counts would notice. These two workspaces
   * answer the same specifier differently, and they are resolved alternately.
   */
  it('two different workspaces answer the same specifier differently', () => {
    const a = new Set(['src/util.js', FROM_FILE]);
    const b = new Set(['vendor/util.js', FROM_FILE]);

    expect(resolveImportTarget('util', FROM_FILE, a, undefined)).toBe('src/util.js');
    expect(resolveImportTarget('util', FROM_FILE, b, undefined)).toBe('vendor/util.js');
    expect(resolveImportTarget('util', FROM_FILE, a, undefined)).toBe('src/util.js');
    expect(resolveImportTarget('util', FROM_FILE, b, undefined)).toBe('vendor/util.js');
  });

  /**
   * The arm that fails without the suffix index, and the reason it is here
   * rather than in the counting arms above: a repo-root file has no `/`, so
   * `suffixResolve`'s scan — which tests `endsWith('/' + suffix)` — can never
   * match it, while `buildSuffixIndex` indexes the whole path and can.
   * Dropping `index` from the pass cache turns every one of these back to null
   * while leaving `files.scans` at 2.
   */
  it('resolves a repo-root module by bare specifier — impossible without the index', () => {
    const files = buildWorkspace(5);

    expect(resolveImportTarget('config', FROM_FILE, files, undefined)).toBe('config.js');
    expect(resolveImportTarget('bootstrap', FROM_FILE, files, undefined)).toBe('bootstrap.cjs');

    // Not `'config.js'`, and that is unchanged by the index: a specifier with
    // no `/` has its dots turned into slashes before the suffix cascade
    // (`resolveImportPath`), so `config.js` is looked up as `config/js`.
    // TypeScript answers null here too — it is the same code path.
    expect(resolveImportTarget('config.js', FROM_FILE, files, undefined)).toBeNull();
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // Relative, with and without an extension.
    expect(resolveImportTarget('./util', FROM_FILE, files, undefined)).toBe('src/util.js');
    expect(resolveImportTarget('./util.js', FROM_FILE, files, undefined)).toBe('src/util.js');
    // Directory index.
    expect(resolveImportTarget('./models', FROM_FILE, files, undefined)).toBe(
      'src/models/index.js',
    );
    // Bare specifier resolved by path suffix, and an ESM extension.
    expect(resolveImportTarget('components/Widget00000', FROM_FILE, files, undefined)).toBe(
      'src/components/Widget00000.js',
    );
    expect(resolveImportTarget('lib/esm', FROM_FILE, files, undefined)).toBe('lib/esm.mjs');
    // A package in node_modules.
    expect(resolveImportTarget('dep', FROM_FILE, files, undefined)).toBe(
      'node_modules/dep/index.js',
    );

    // Nothing in the repo answers these.
    expect(resolveImportTarget('./nowhere', FROM_FILE, files, undefined)).toBeNull();
    expect(resolveImportTarget('@vendor/ghost/deep', FROM_FILE, files, undefined)).toBeNull();
  });
});
