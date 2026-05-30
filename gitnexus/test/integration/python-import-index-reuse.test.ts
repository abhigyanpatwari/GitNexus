/**
 * Production-path regression guard for PR #1918 review finding P1.
 *
 * The Python file index (`getPythonFileIndex` in `import-target.ts`) is
 * memoized on the `allFilePaths` Set identity via a WeakMap. The registry-
 * primary path reaches it through `pythonScopeResolver.resolveImportTarget`
 * (the orchestrator adapter) — NOT by calling `resolvePythonImportTarget`
 * directly the way the unit parity test does. Before the fix, that adapter
 * copied the set (`new Set(allFilePaths)`) on every import, handing a fresh
 * WeakMap key per call so the index rebuilt every import (O(imports × files)).
 *
 * This test drives the adapter exactly as the orchestrator does and asserts the
 * index is built ONCE across many imports on a stable set. It fails (build
 * count == number of imports) if the per-import copy is reintroduced.
 */
import { describe, it, expect } from 'vitest';
import { pythonScopeResolver } from '../../src/core/ingestion/languages/python/scope-resolver.js';
import {
  getPythonFileIndexBuildCount,
  resetPythonFileIndexBuildCount,
} from '../../src/core/ingestion/languages/python/index-stats.js';

/**
 * A synthetic workspace: a real package (`realpkg/__init__.py`, so the
 * `hasRepoCandidate` gate passes) plus many unrelated modules. The imports
 * below are multi-segment and miss every fast path, so each call reaches both
 * `hasRepoCandidate` and `resolveAbsoluteFromFiles` — the two index consumers.
 */
function buildWorkspace(fileCount: number): Set<string> {
  const files = new Set<string>();
  for (let i = 0; i < fileCount; i++) {
    files.add(`pkg/sub/mod${String(i).padStart(5, '0')}.py`);
  }
  files.add('realpkg/__init__.py');
  files.add('realpkg/widget.py');
  return files;
}

describe('Python import resolution — index reuse across imports (PR #1918 P1)', () => {
  it('builds the file index once for many imports over a stable file set', () => {
    const allFilePaths = buildWorkspace(300);
    const fromFile = 'app/main.py';
    const importCount = 300;

    resetPythonFileIndexBuildCount();
    for (let i = 0; i < importCount; i++) {
      // Multi-segment, candidate-passing, suffix-miss → reaches the index.
      pythonScopeResolver.resolveImportTarget(`realpkg.ghost${i}`, fromFile, allFilePaths);
    }

    // The whole point of PR #1918: O(imports + files), not O(imports × files).
    // Pre-fix this was 300 (one rebuild per import via the adapter's Set copy).
    expect(getPythonFileIndexBuildCount()).toBe(1);
  });

  it('rebuilds once per distinct file set (per-run isolation, no stale reuse)', () => {
    const fromFile = 'app/main.py';

    resetPythonFileIndexBuildCount();
    const setA = buildWorkspace(50);
    for (let i = 0; i < 20; i++) {
      pythonScopeResolver.resolveImportTarget(`realpkg.ghost${i}`, fromFile, setA);
    }
    expect(getPythonFileIndexBuildCount()).toBe(1);

    // A different Set instance is a different logical workspace → one more build.
    const setB = buildWorkspace(50);
    for (let i = 0; i < 20; i++) {
      pythonScopeResolver.resolveImportTarget(`realpkg.ghost${i}`, fromFile, setB);
    }
    expect(getPythonFileIndexBuildCount()).toBe(2);
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const allFilePaths = buildWorkspace(20);
    const fromFile = 'app/main.py';

    // Suffix-fallback hit through the adapter: realpkg.widget → realpkg/widget.py.
    expect(pythonScopeResolver.resolveImportTarget('realpkg.widget', fromFile, allFilePaths)).toBe(
      'realpkg/widget.py',
    );
    // Gated-out / unresolvable import returns null.
    expect(
      pythonScopeResolver.resolveImportTarget('realpkg.ghost', fromFile, allFilePaths),
    ).toBeNull();
  });
});
