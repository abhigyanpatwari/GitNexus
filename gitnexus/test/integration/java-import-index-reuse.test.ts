/**
 * Production-path regression guard for the Java import-resolution indexes
 * (#2908).
 *
 * `resolveJavaImportTarget` reads TWO per-file-set indexes, each memoized on
 * the `allFilePaths` Set identity via its own WeakMap: the shared
 * `getWorkspaceFileIndex` (`import-resolvers/workspace-file-index.ts`, which
 * answers the whole-path and segment-suffix legs) and `getJavaDirIndex`
 * (`languages/java/import-target.ts`, the package-directory index behind
 * `firstFileDirectlyInPkgDir`). Before the hoist every leg was a full
 * `allFilePaths` scan, and the progressive-stripping loop re-ran that scan once
 * per stripped segment — so a four-segment `import` that resolves to nothing,
 * which is what every JDK and third-party import does, cost four full passes.
 *
 * Resolution reaches both indexes through `javaScopeResolver.resolveImportTarget`
 * — the orchestrator adapter — not by calling `resolveJavaImportTarget` directly
 * the way the unit parity test does. The adapter must therefore pass the Set
 * THROUGH; a defensive copy (`new Set(allFilePaths)`) would hand a fresh WeakMap
 * key per call and rebuild BOTH indexes on every import, restoring the
 * O(imports × files) behaviour this replaced. Python hit exactly that (PR #1918
 * review P1), and `test/unit/scope-resolution/java-import-target-parity.test.ts`
 * cannot see it: it never crosses the adapter.
 *
 * The counting instrument has to be a real `Set` subclass: `narrowContext`
 * rejects a workspace context whose `allFilePaths` fails `instanceof Set`, and a
 * rejected context resolves nothing — every assertion would then pass on
 * `null === null`.
 *
 * The traversal-count assertions are the perf guard. They are paired with result
 * assertions on purpose: a count of 2 is equally true of an adapter that has
 * stopped resolving anything at all, so counting alone would stay green while
 * every Java IMPORTS edge disappeared.
 */
import { describe, it, expect } from 'vitest';
import { javaScopeResolver } from '../../src/core/ingestion/languages/java/scope-resolver.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = javaScopeResolver;

const FROM_FILE = 'src/main/java/com/example/App.java';

/**
 * A synthetic Java source tree covering all four legs of the cascade:
 * `com/example/model/User.java` answers the whole-path lookup,
 * `src/main/java/com/example/service/` answers the package-directory lookup a
 * wildcard import lands on, `src/main/java/com/example/util/Strings.java`
 * answers the nested-suffix lookup, and `domain/Order.java` is reachable only
 * after progressive prefix stripping.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`src/main/java/com/example/service/Service${String(i).padStart(5, '0')}.java`);
  }
  files.push('com/example/model/User.java');
  files.push('src/main/java/com/example/util/Strings.java');
  files.push('domain/Order.java');
  files.push(FROM_FILE);
  return new CountingSet(files);
}

describe('Java import resolution — index reuse across imports (#2908)', () => {
  it('builds each index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // A whole-path hit, a nested-suffix hit, a package-directory hit via a
      // wildcard, and a miss that runs the full progressive-stripping cascade —
      // the case that used to re-scan the workspace once per stripped prefix.
      resolved.push(resolveImportTarget('com.example.model.User', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget('com.example.util.Strings', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget('com.example.service.*', FROM_FILE, files, undefined));
      resolved.push(
        resolveImportTarget(`vendor${i}.ghost.deep.Missing`, FROM_FILE, files, undefined),
      );
    }

    // Two passes: the shared workspace/suffix index and the package-dir index.
    // Not one: they are separate WeakMaps and `buildPackageDirIndex` takes the
    // Set, so each iterates it once — the same accounting as C# (#2878).
    expect(files.scans).toBe(2);

    // Paired result assertions — a count of 2 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBe('com/example/model/User.java');
    expect(resolved[1]).toBe('src/main/java/com/example/util/Strings.java');
    expect(resolved[2]).toBe('src/main/java/com/example/service/Service00000.java');
    expect(resolved[3]).toBeNull();
  });

  it('a distinct file set gets its own indexes (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(20),
      targetRaw: 'com.example.model.User',
      fromFile: FROM_FILE,
      resolutionConfig: undefined,
      expected: 'com/example/model/User.java',
      // Two, not one: the shared workspace/suffix index and the package-dir
      // index are separate WeakMaps over the same Set.
      expectedScans: 2,
    });
  });

  it('still resolves real imports correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // Whole-path match on the package path.
    expect(resolveImportTarget('com.example.model.User', FROM_FILE, files, undefined)).toBe(
      'com/example/model/User.java',
    );
    // Nested suffix match under the source root.
    expect(resolveImportTarget('com.example.util.Strings', FROM_FILE, files, undefined)).toBe(
      'src/main/java/com/example/util/Strings.java',
    );
    // Wildcard: `.*` is stripped and the package directory answers with its
    // first `.java` child in file-set order.
    expect(resolveImportTarget('com.example.service.*', FROM_FILE, files, undefined)).toBe(
      'src/main/java/com/example/service/Service00000.java',
    );
    // Progressive prefix stripping: the repo has no `com/shop/` prefix.
    expect(resolveImportTarget('com.shop.domain.Order', FROM_FILE, files, undefined)).toBe(
      'domain/Order.java',
    );

    // Unknown packages resolve to nothing.
    expect(resolveImportTarget('vendor.ghost.Missing', FROM_FILE, files, undefined)).toBeNull();
  });
});
