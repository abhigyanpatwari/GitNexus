/**
 * Production-path regression guard for the Go import-resolution index (#2877).
 *
 * The package-directory index (`getGoPackageIndex` in
 * `languages/go/import-target.ts`) is memoized on the `allFilePaths` Set
 * identity via a WeakMap. Resolution reaches it through
 * `goScopeResolver.resolveImportTarget` — the orchestrator adapter — not by
 * calling `resolveGoImportTarget` directly the way the unit parity test does.
 * The adapter must therefore pass the Set THROUGH; a defensive copy
 * (`new Set(allFilePaths)`) would hand a fresh WeakMap key per call and rebuild
 * the index on every import, restoring the O(imports × files) behaviour this
 * replaced. Python hit exactly that (PR #1918 review P1), and the parity test
 * cannot see it: it never crosses the adapter.
 *
 * Kotlin and Python count index BUILDS from production (`index-stats.ts`).
 * These four use `CountingSet` (`test/helpers/counting-file-set.ts`) instead,
 * which counts full traversals of the file set and so catches BOTH the
 * per-import rebuild and a scan reintroduced beside a reused index — with no
 * production surface added for a test-only observation.
 *
 * The traversal-count assertions are the perf guard. They are paired with
 * result assertions on purpose: a count of 1 is equally true of an adapter that
 * has stopped resolving anything at all, so counting alone would stay green
 * while every Go IMPORTS edge disappeared.
 */
import { describe, it, expect } from 'vitest';
import { goScopeResolver } from '../../src/core/ingestion/languages/go/scope-resolver.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

// `resolveImportTarget` is a required member of `ScopeResolver`, so this is a
// plain read — no optional call, and no `toBeDefined()` guarding a branch that
// cannot be taken.
const { resolveImportTarget } = goScopeResolver;

/** The value `loadGoModulePath` produces for a repo with a `go.mod`. */
const GO_MODULE = { modulePath: 'example.com/mod' };

const FROM_FILE = 'main.go';

/**
 * A synthetic Go module: many sibling packages under `internal/`, one package
 * with two real files plus a `_test.go` that the package leg must exclude, and
 * a root-package file for the `targetRaw === modulePath` leg.
 */
function buildWorkspace(pkgCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < pkgCount; i++) {
    files.push(`internal/pkg${String(i).padStart(5, '0')}/service.go`);
  }
  files.push('internal/models/user.go');
  files.push('internal/models/order.go');
  files.push('internal/models/user_test.go');
  files.push('main.go');
  return new CountingSet(files);
}

describe('Go import resolution — index reuse across imports (#2877)', () => {
  it('builds the package index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // Three shapes that between them reach every leg: the module-relative
      // package leg, the root-package leg, and a third-party path that misses
      // and so runs the whole GOPATH suffix cascade to completion — the case
      // that used to cost one full workspace scan per path segment.
      resolved.push(
        resolveImportTarget('example.com/mod/internal/models', FROM_FILE, files, GO_MODULE),
      );
      resolved.push(resolveImportTarget('example.com/mod', FROM_FILE, files, GO_MODULE));
      resolved.push(
        resolveImportTarget(`github.com/vendor/dep${i}/sub`, FROM_FILE, files, GO_MODULE),
      );
    }

    // One pass: the package-dir index (root files are collected in the same pass).
    expect(files.scans).toBe(1);

    // Paired result assertion — a count of 1 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toEqual(['internal/models/user.go', 'internal/models/order.go']);
    expect(resolved[1]).toEqual(['main.go']);
    expect(resolved[2]).toBeNull();
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(20),
      targetRaw: 'example.com/mod/internal/models',
      fromFile: FROM_FILE,
      resolutionConfig: GO_MODULE,
      expected: ['internal/models/user.go', 'internal/models/order.go'],
      expectedScans: 1,
    });
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // Module-relative package: every non-test `.go` file in the directory, in
    // file-set order, one ImportEdge target each.
    expect(
      resolveImportTarget('example.com/mod/internal/models', FROM_FILE, files, GO_MODULE),
    ).toEqual(['internal/models/user.go', 'internal/models/order.go']);

    // Root package: the module path itself, and this leg IS sorted.
    expect(resolveImportTarget('example.com/mod', FROM_FILE, files, GO_MODULE)).toEqual([
      'main.go',
    ]);

    // No go.mod config: the GOPATH cascade reaches the same package by suffix.
    expect(
      resolveImportTarget('example.com/mod/internal/models', FROM_FILE, files, undefined),
    ).toEqual(['internal/models/user.go', 'internal/models/order.go']);

    // Stdlib and third-party imports resolve to nothing in the workspace.
    expect(resolveImportTarget('fmt', FROM_FILE, files, GO_MODULE)).toBeNull();
    expect(resolveImportTarget('github.com/spf13/cobra', FROM_FILE, files, GO_MODULE)).toBeNull();
  });
});
