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
 * The build-count assertions are the perf guard. They are paired with result
 * assertions on purpose: a build count of 1 is equally true of an adapter that
 * has stopped resolving anything at all, so counting alone would stay green
 * while every Kotlin IMPORTS edge disappeared.
 */
import { describe, it, expect } from 'vitest';
import { kotlinScopeResolver } from '../../src/core/ingestion/languages/kotlin/scope-resolver.js';
import {
  getKotlinFileIndexBuildCount,
  resetKotlinFileIndexBuildCount,
} from '../../src/core/ingestion/languages/kotlin/index-stats.js';

// `resolveImportTarget` is a required member of `ScopeResolver`, so this is a
// plain read — no optional call, and no `toBeDefined()` guarding a branch that
// cannot be taken.
const { resolveImportTarget } = kotlinScopeResolver;

/**
 * A synthetic workspace shaped like a Gradle monorepo: per-module source roots
 * over one shared package namespace, so a package is reachable only as a path
 * suffix and never at the workspace root.
 */
function buildWorkspace(fileCount: number): Set<string> {
  const files = new Set<string>();
  for (let i = 0; i < fileCount; i++) {
    files.add(`lib${String(i).padStart(5, '0')}/src/main/kotlin/com/example/widget/Widget${i}.kt`);
  }
  files.add('common/src/main/kotlin/com/example/common/Util.kt');
  return files;
}

const FROM_FILE = 'common/src/main/kotlin/com/example/common/Util.kt';

describe('Kotlin import resolution — index reuse across imports', () => {
  it('builds the file index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    resetKotlinFileIndexBuildCount();

    for (let i = 0; i < 200; i++) {
      // Alternates the two tiers that dominate real Kotlin source: a named type
      // (tier 1, reached by path suffix) and a top-level function, which has no
      // file named after it and so falls through to the package fan-out
      // (#1759). Driving one tier only would leave the other unmeasured here.
      const target =
        i % 2 === 0 ? `com.example.widget.Widget${i}` : `com.example.widget.someTopLevelFun${i}`;
      resolveImportTarget(target, FROM_FILE, files);
    }

    expect(getKotlinFileIndexBuildCount()).toBe(1);
  });

  it('rebuilds when the file set is a different object', () => {
    resetKotlinFileIndexBuildCount();

    for (let i = 0; i < 3; i++) {
      resolveImportTarget('com.example.common.Util', 'a/B.kt', buildWorkspace(5));
    }

    expect(getKotlinFileIndexBuildCount()).toBe(3);
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(20);

    // Tier 1 through the adapter. The package sits under a module source root,
    // so this resolves by path suffix, not by an exact workspace-rooted match.
    expect(resolveImportTarget('com.example.widget.Widget7', FROM_FILE, files)).toBe(
      'lib00007/src/main/kotlin/com/example/widget/Widget7.kt',
    );

    // Tier 3 through the adapter: a top-level function has no file named after
    // it, so the stripped path resolves to the package directory and fans out
    // to every file in it. The finalize pass then picks the one whose localDefs
    // export the name (#1759).
    const fanOut = resolveImportTarget('com.example.widget.someTopLevelFun', FROM_FILE, files);
    expect(fanOut).toHaveLength(20);
    expect(fanOut).toContain('lib00000/src/main/kotlin/com/example/widget/Widget0.kt');

    // An import that matches nothing in the workspace resolves to null.
    expect(resolveImportTarget('org.absent.pkg.Missing', FROM_FILE, files)).toBeNull();
  });
});
