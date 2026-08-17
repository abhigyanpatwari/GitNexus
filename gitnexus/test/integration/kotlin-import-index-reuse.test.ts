/**
 * Production-path regression guard for the Kotlin import-resolution index.
 *
 * The index (`getKotlinFileIndex` in `languages/kotlin/import-target.ts`) is
 * memoized on the `allFilePaths` Set identity via a WeakMap. Resolution reaches
 * it through `kotlinScopeResolver.resolveImportTarget` — the orchestrator
 * adapter — not by calling `resolveKotlinImportTarget` directly the way the
 * unit parity test does. The adapter must therefore pass the Set THROUGH; a
 * defensive copy (`new Set(allFilePaths)`) would hand a fresh WeakMap key per
 * call and rebuild the index on every import, restoring the O(imports × files)
 * behaviour this replaced. Python hit exactly that (PR #1918 review P1).
 *
 * ## Why this counts TRAVERSALS and not index builds (#2909)
 *
 * This guard used to read a build counter that shipped in production purely so
 * a test could read it (now deleted). `CountingSet`
 * (`test/helpers/counting-file-set.ts`) replaces it, and the swap is not a
 * wash:
 *
 *  - STRICTLY MORE COVERAGE. A scan added BESIDE a reused index moves no build
 *    count — the cache still hits, the counter still reads 1 — but it does move
 *    the traversal count. That mutation is the one `bench/import-target/`
 *    provably cannot see either: `baselines.json` `_blind_spot` records a full
 *    workspace scan on 1-in-32 imports passing every timing arm.
 *  - LESS PRODUCTION SURFACE. ~30 lines shipped in the bundle whose only caller
 *    outside a cache miss was this file.
 *  - PARALLEL-SAFE. The counter lives on the instance the test built, so there
 *    is no module-global to `reset()` and no ordering hazard between tests.
 *
 * The traversal-count assertions are the perf guard. They are paired with result
 * assertions on purpose: a count of 1 is equally true of an adapter that has
 * stopped resolving anything at all, so counting alone would stay green while
 * every Kotlin IMPORTS edge disappeared.
 */
import { describe, it, expect } from 'vitest';
import { kotlinScopeResolver } from '../../src/core/ingestion/languages/kotlin/scope-resolver.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

// `resolveImportTarget` is a required member of `ScopeResolver`, so this is a
// plain read — no optional call, and no `toBeDefined()` guarding a branch that
// cannot be taken.
const { resolveImportTarget } = kotlinScopeResolver;

/**
 * A synthetic workspace shaped like a Gradle monorepo: per-module source roots
 * over one shared package namespace, so a package is reachable only as a path
 * suffix and never at the workspace root.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`lib${String(i).padStart(5, '0')}/src/main/kotlin/com/example/widget/Widget${i}.kt`);
  }
  files.push('common/src/main/kotlin/com/example/common/Util.kt');
  return new CountingSet(files);
}

const FROM_FILE = 'common/src/main/kotlin/com/example/common/Util.kt';

describe('Kotlin import resolution — index reuse across imports', () => {
  it('builds the file index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 100; i++) {
      // Both tiers that dominate real Kotlin source, every iteration: a named
      // type (tier 1, reached by path suffix) and a top-level function, which
      // has no file named after it and so falls through to the package fan-out
      // (#1759). Driving one tier only would leave the other unmeasured here.
      resolved.push(
        resolveImportTarget(`com.example.widget.Widget${i}`, FROM_FILE, files, undefined),
      );
      resolved.push(
        resolveImportTarget(`com.example.widget.someTopLevelFun${i}`, FROM_FILE, files, undefined),
      );
    }
    // An import that matches nothing at all, which runs the whole cascade —
    // every tier misses and the progressive prefix strip walks to the end.
    resolved.push(resolveImportTarget('org.absent.pkg.Missing', FROM_FILE, files, undefined));

    expect(files.scans).toBe(1);

    // Paired result assertions — a count of 1 must not be the count of an
    // adapter that resolves nothing. Tier 1 by path suffix, tier 3 fanning out
    // over the package directory, and the total miss.
    expect(resolved[0]).toBe('lib00000/src/main/kotlin/com/example/widget/Widget0.kt');
    expect(resolved[1]).toHaveLength(300);
    expect(resolved[200]).toBeNull();
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(5),
      targetRaw: 'com.example.common.Util',
      fromFile: 'a/B.kt',
      resolutionConfig: undefined,
      expected: 'common/src/main/kotlin/com/example/common/Util.kt',
      expectedScans: 1,
    });
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(20);

    // Tier 1 through the adapter. The package sits under a module source root,
    // so this resolves by path suffix, not by an exact workspace-rooted match.
    expect(resolveImportTarget('com.example.widget.Widget7', FROM_FILE, files, undefined)).toBe(
      'lib00007/src/main/kotlin/com/example/widget/Widget7.kt',
    );

    // Tier 3 through the adapter: a top-level function has no file named after
    // it, so the stripped path resolves to the package directory and fans out
    // to every file in it. The finalize pass then picks the one whose localDefs
    // export the name (#1759).
    const fanOut = resolveImportTarget(
      'com.example.widget.someTopLevelFun',
      FROM_FILE,
      files,
      undefined,
    );
    expect(fanOut).toHaveLength(20);
    expect(fanOut).toContain('lib00000/src/main/kotlin/com/example/widget/Widget0.kt');

    // An import that matches nothing in the workspace resolves to null.
    expect(resolveImportTarget('org.absent.pkg.Missing', FROM_FILE, files, undefined)).toBeNull();

    // All of it off one traversal.
    expect(files.scans).toBe(1);
  });
});
