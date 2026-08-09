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
 * file set is traversed ONCE across many imports on a stable set. It fails
 * (one traversal per import) if the per-import copy is reintroduced.
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
 * every Python IMPORTS edge disappeared.
 */
import { describe, it, expect } from 'vitest';
import { pythonScopeResolver } from '../../src/core/ingestion/languages/python/scope-resolver.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = pythonScopeResolver;

const FROM_FILE = 'app/main.py';

/**
 * A synthetic workspace: a real package (`realpkg/__init__.py`, so the
 * `hasRepoCandidate` gate passes) plus many unrelated modules. The imports
 * below are multi-segment and miss every fast path, so each call reaches both
 * `hasRepoCandidate` and `resolveAbsoluteFromFiles` — the two index consumers.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`pkg/sub/mod${String(i).padStart(5, '0')}.py`);
  }
  files.push('realpkg/__init__.py');
  files.push('realpkg/widget.py');
  return new CountingSet(files);
}

describe('Python import resolution — index reuse across imports (PR #1918 P1)', () => {
  it('builds the file index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 300; i++) {
      // Multi-segment, candidate-passing, suffix-miss → reaches the index.
      resolved.push(resolveImportTarget(`realpkg.ghost${i}`, FROM_FILE, files, undefined));
    }
    resolved.push(resolveImportTarget('realpkg.widget', FROM_FILE, files, undefined));

    // The whole point of PR #1918: O(imports + files), not O(imports × files).
    // Pre-fix this was 300 (one rebuild per import via the adapter's Set copy).
    expect(files.scans).toBe(1);

    // Paired result assertions — a count of 1 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBeNull();
    expect(resolved[300]).toBe('realpkg/widget.py');
  });

  it('a distinct file set gets its own index (per-run isolation, no stale reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(50),
      targetRaw: 'realpkg.widget',
      fromFile: FROM_FILE,
      resolutionConfig: undefined,
      expected: 'realpkg/widget.py',
      expectedScans: 1,
    });
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(20);

    // Suffix-fallback hit through the adapter: realpkg.widget → realpkg/widget.py.
    expect(resolveImportTarget('realpkg.widget', FROM_FILE, files, undefined)).toBe(
      'realpkg/widget.py',
    );
    // Gated-out / unresolvable import returns null.
    expect(resolveImportTarget('realpkg.ghost', FROM_FILE, files, undefined)).toBeNull();

    // All of it off one traversal.
    expect(files.scans).toBe(1);
  });
});
