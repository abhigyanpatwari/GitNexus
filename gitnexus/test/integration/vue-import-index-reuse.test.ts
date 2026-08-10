/**
 * Production-path regression guard for the Vue import-resolution pass cache
 * (#2910).
 *
 * `makeVueResolveImportTarget` is the TypeScript adapter with the language
 * pinned to TypeScript, and it inherited the same memo: a single slot,
 * invalidated by `cached.key !== allFilePaths`. One file set is memoized
 * perfectly; two alternating file sets rebuild the arrays, the suffix index and
 * the `resolveCache` on every call. Measured on the identical TypeScript
 * adapter at 4000 files × 400 imports: 12.0 ms for one set, 1438.2 ms
 * alternating between two — 120x, and the same O(imports × files) shape the
 * per-file-set index hoists removed.
 *
 * That is why this adapter could not carry `expectDistinctFileSetsGetOwnIndex`,
 * the one arm every other language's guard has: the arm alternates two sets by
 * construction, and the single-slot cache posts 42 traversals against the 2 it
 * posts now. The cache is a `WeakMap<ReadonlySet<string>, PassCache>` keyed on
 * the Set, like every other language's index, and the arm below is the proof.
 *
 * Whether the thrash was reachable in production: `pipeline/run.ts` builds one
 * `allFilePaths` Set per provider pass and Vue, TypeScript and JavaScript are
 * separate providers with separate caches, so within one analyze it was latent
 * rather than live — one refactor away from live, and the `WeakMap` is strictly
 * simpler than the slot it replaces.
 *
 * Resolution goes through `vueScopeResolver.resolveImportTarget`, the
 * orchestrator adapter, which must pass the Set THROUGH: a defensive
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
import { vueScopeResolver } from '../../src/core/ingestion/languages/vue/scope-resolver.js';
import type { TsconfigPaths } from '../../src/core/ingestion/language-config.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = vueScopeResolver;

const FROM_FILE = 'src/App.vue';

/** What `loadTsconfigPaths` produces for `"@/*": ["src/*"]` under `baseUrl: "."`. */
const TSCONFIG_PATHS: TsconfigPaths = { aliases: new Map([['@/', 'src/']]), baseUrl: '.' };

/** The shape `loadResolutionConfig` returns for a Vue repo with a tsconfig. */
const RESOLUTION_CONFIG = { tsconfigPaths: TSCONFIG_PATHS };

/**
 * A synthetic Vue SFC project: many components, a `.ts` composable reached by
 * bare specifier, a `@/`-aliased path, and a directory `index.ts`. `.vue`
 * imports carry their extension, so they land on the exact-path branch.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`src/components/Widget${String(i).padStart(5, '0')}.vue`);
  }
  files.push('src/composables/useUser.ts');
  files.push('src/stores/index.ts');
  files.push('src/util.ts');
  files.push(FROM_FILE);
  return new CountingSet(files);
}

describe('Vue import resolution — index reuse across imports (#2910)', () => {
  it('builds the pass cache once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // A relative `.vue` hit, a relative `.ts` composable, an aliased path, a
      // bare-specifier suffix hit, and a bare specifier that misses — the
      // expensive case, which runs every path part × every extension before
      // returning null.
      resolved.push(
        resolveImportTarget('./components/Widget00000.vue', FROM_FILE, files, RESOLUTION_CONFIG),
      );
      resolved.push(
        resolveImportTarget('./composables/useUser', FROM_FILE, files, RESOLUTION_CONFIG),
      );
      resolved.push(resolveImportTarget('@/stores', FROM_FILE, files, RESOLUTION_CONFIG));
      resolved.push(
        resolveImportTarget('composables/useUser', FROM_FILE, files, RESOLUTION_CONFIG),
      );
      resolved.push(
        resolveImportTarget(`@vendor/ghost${i}/deep`, FROM_FILE, files, RESOLUTION_CONFIG),
      );
    }

    // Two: `Array.from(allFilePaths)` and the one mutable `Set` copy the
    // resolver context requires. Both happen once per file set.
    expect(files.scans).toBe(2);

    // Paired result assertions — a count of 2 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBe('src/components/Widget00000.vue');
    expect(resolved[1]).toBe('src/composables/useUser.ts');
    expect(resolved[2]).toBe('src/stores/index.ts');
    expect(resolved[3]).toBe('src/composables/useUser.ts');
    expect(resolved[4]).toBeNull();
  });

  /**
   * The arm the single-slot cache could not pass. `expectDistinctFileSetsGetOwnIndex`
   * alternates two file sets 20 times; the slot was invalidated on every one of
   * those calls, so each set posted 42 traversals instead of 2.
   */
  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(20),
      targetRaw: '@/stores',
      fromFile: FROM_FILE,
      resolutionConfig: RESOLUTION_CONFIG,
      expected: 'src/stores/index.ts',
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
    const a = new Set(['src/util.ts', FROM_FILE]);
    const b = new Set(['vendor/util.ts', FROM_FILE]);

    expect(resolveImportTarget('util', FROM_FILE, a, RESOLUTION_CONFIG)).toBe('src/util.ts');
    expect(resolveImportTarget('util', FROM_FILE, b, RESOLUTION_CONFIG)).toBe('vendor/util.ts');
    expect(resolveImportTarget('util', FROM_FILE, a, RESOLUTION_CONFIG)).toBe('src/util.ts');
    expect(resolveImportTarget('util', FROM_FILE, b, RESOLUTION_CONFIG)).toBe('vendor/util.ts');
  });

  it('still resolves real SFC imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // `.vue` imports are written with their extension and hit the exact-path
    // branch.
    expect(
      resolveImportTarget('./components/Widget00000.vue', FROM_FILE, files, RESOLUTION_CONFIG),
    ).toBe('src/components/Widget00000.vue');
    // A composable, relative and extensionless.
    expect(resolveImportTarget('./composables/useUser', FROM_FILE, files, RESOLUTION_CONFIG)).toBe(
      'src/composables/useUser.ts',
    );
    // Directory index behind a tsconfig alias.
    expect(resolveImportTarget('@/stores', FROM_FILE, files, RESOLUTION_CONFIG)).toBe(
      'src/stores/index.ts',
    );
    // Bare specifier resolved by path suffix.
    expect(
      resolveImportTarget('components/Widget00000.vue', FROM_FILE, files, RESOLUTION_CONFIG),
    ).toBe('src/components/Widget00000.vue');

    // Nothing in the repo answers these.
    expect(resolveImportTarget('./Missing.vue', FROM_FILE, files, RESOLUTION_CONFIG)).toBeNull();
    expect(
      resolveImportTarget('@vendor/ghost/deep', FROM_FILE, files, RESOLUTION_CONFIG),
    ).toBeNull();
  });
});
