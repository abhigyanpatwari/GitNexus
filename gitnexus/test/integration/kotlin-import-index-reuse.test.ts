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
 * This test drives the adapter as the orchestrator does and asserts the index
 * is built ONCE across many imports on a stable set. It fails (build count ==
 * number of imports) if a per-import copy is introduced.
 */
import { describe, it, expect } from 'vitest';
import { kotlinScopeResolver } from '../../src/core/ingestion/languages/kotlin/scope-resolver.js';
import {
  getKotlinFileIndexBuildCount,
  resetKotlinFileIndexBuildCount,
} from '../../src/core/ingestion/languages/kotlin/index-stats.js';

/**
 * A synthetic workspace shaped like the repository that exposed the problem: a
 * deep package tree where imports miss the cheap tiers and reach the package
 * fan-out, so every call would have scanned the whole set.
 */
function buildWorkspace(fileCount: number): Set<string> {
  const files = new Set<string>();
  for (let i = 0; i < fileCount; i++) {
    files.add(`lib${String(i).padStart(5, '0')}/src/main/kotlin/com/example/widget/Widget${i}.kt`);
  }
  files.add('common/src/main/kotlin/com/example/common/Util.kt');
  return files;
}

describe('Kotlin import resolution — index reuse across imports', () => {
  it('builds the file index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    resetKotlinFileIndexBuildCount();

    const resolveImportTarget = kotlinScopeResolver.resolveImportTarget;
    expect(resolveImportTarget).toBeDefined();

    for (let i = 0; i < 200; i++) {
      resolveImportTarget?.(
        `com.example.widget.Widget${i}`,
        'common/src/main/kotlin/com/example/common/Util.kt',
        files,
        undefined as never,
        undefined as never,
      );
    }

    expect(getKotlinFileIndexBuildCount()).toBe(1);
  });

  it('rebuilds when the file set is a different object', () => {
    resetKotlinFileIndexBuildCount();
    const resolveImportTarget = kotlinScopeResolver.resolveImportTarget;

    for (let i = 0; i < 3; i++) {
      resolveImportTarget?.(
        'com.example.common.Util',
        'a/B.kt',
        buildWorkspace(5),
        undefined as never,
        undefined as never,
      );
    }

    expect(getKotlinFileIndexBuildCount()).toBe(3);
  });
});
