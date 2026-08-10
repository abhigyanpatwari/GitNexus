/**
 * Production-path regression guard for the C# import-resolution indexes (#2878).
 *
 * The no-csproj `using` path reads TWO per-file-set indexes, each memoized on
 * the `allFilePaths` Set identity via its own WeakMap: the shared
 * `getWorkspaceFileIndex` (`import-resolvers/workspace-file-index.ts`, used by
 * both the csproj and no-csproj legs) and `getCsharpDirIndex`
 * (`languages/csharp/import-target.ts`, the namespace-directory index behind
 * `firstFileDirectlyInPkgDir`). A four-segment `using` used to cost up to eight
 * full workspace passes.
 *
 * Resolution reaches both through `csharpScopeResolver.resolveImportTarget` —
 * the orchestrator adapter — not by calling `resolveCsharpImportTarget`
 * directly the way the unit parity test does. The adapter must therefore pass
 * the Set THROUGH; a defensive copy (`new Set(allFilePaths)`) would hand a
 * fresh WeakMap key per call and rebuild BOTH indexes on every `using`,
 * restoring the O(usings × files) behaviour this replaced. Python hit exactly
 * that (PR #1918 review P1), and the parity test cannot see it: it never
 * crosses the adapter.
 *
 * C# is also the reason the counting instrument has to be a real `Set`
 * subclass: `narrowContext` rejects a workspace context whose `allFilePaths`
 * fails `instanceof Set`, and a rejected context resolves nothing — every
 * assertion would then pass on `null === null`.
 *
 * The traversal-count assertions are the perf guard. They are paired with
 * result assertions on purpose: a count of 2 is equally true of an adapter that
 * has stopped resolving anything at all, so counting alone would stay green
 * while every C# IMPORTS edge disappeared.
 *
 * ## The csproj leg is guarded by the SAME instrument (#2911 review)
 *
 * With `.csproj` configs present the adapter takes a different branch entirely
 * — `resolveCSharpImportInternal` — and that branch used to be unguarded here:
 * no arm supplied `csharpConfigs`, so no counting Set ever entered it. Worse,
 * its namespace-directory index was keyed on the `normalizedFileList` ARRAY, a
 * shape no scan count can instrument — a `[...normalized]` copy at the adapter
 * boundary rebuilt the index once per `using` while traversing the Set exactly
 * zero extra times. Reproduced against this PR's tree: the copy left all 67
 * tests of the four import-index guards green and only the timing bench
 * noticed (`csharp_csproj scaling 3.556 > 1.8`).
 *
 * #2911 rekeyed that index onto the Set, so the array shape is gone and the
 * only remaining way to defeat the memo — copying the Set — is what
 * `CountingSet` already counts. The csproj arms below therefore read the same
 * one number as the arms above, with no second instrument.
 */
import { describe, it, expect } from 'vitest';
import { csharpScopeResolver } from '../../src/core/ingestion/languages/csharp/scope-resolver.js';
import type { CsharpResolutionConfig } from '../../src/core/ingestion/languages/csharp/resolution-config.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = csharpScopeResolver;

const FROM_FILE = 'App/Program.cs';

/**
 * A synthetic C# solution with no `.csproj` discovered, which is the leg #2878
 * moved onto the indexes. `App/Models/User.cs` answers the whole-path lookup,
 * `App/Services/` answers the namespace-directory lookup, and `Domain/Order.cs`
 * is reachable only after progressive prefix stripping.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`App/Services/Service${String(i).padStart(5, '0')}.cs`);
  }
  files.push('App/Models/User.cs');
  files.push('Domain/Order.cs');
  files.push('App/Program.cs');
  return new CountingSet(files);
}

/** The one `.csproj` config that puts the adapter on the csproj leg. */
const CSPROJ_CONFIG: CsharpResolutionConfig = {
  csharpConfigs: [{ rootNamespace: 'App', projectDir: 'App' }],
};

/**
 * A workspace whose `App.Models` resolution reaches the namespace-DIRECTORY
 * index, which is the only thing on the csproj leg keyed on the array.
 *
 * That takes a layout the first two legs both miss. `src/MyApp/Models/` answers
 * `dirPrefix = 'App/Models'` under the unanchored substring rule ('MyApp/'
 * supplies the 'App/'), and under nothing weaker: no file is named
 * `App/Models.cs` or `Models.cs`, so the single-file leg misses, and no
 * directory has the SEGMENT suffix `App/Models`, so `getFilesInDir` misses too.
 * A layout where the first two legs answer would leave the index unbuilt and
 * the build count blind to the very copy it is here to catch.
 */
function buildCsprojWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`src/MyApp/Models/Entity${String(i).padStart(5, '0')}.cs`);
  }
  files.push('App/Program.cs');
  return new CountingSet(files);
}

describe('C# import resolution — index reuse across usings (#2878)', () => {
  it('builds each index once for many usings over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // A whole-path hit, a namespace-directory hit, and a miss that runs the
      // full progressive-stripping cascade — the case that used to re-scan the
      // workspace once per stripped prefix.
      resolved.push(resolveImportTarget('App.Models.User', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget('App.Services', FROM_FILE, files, undefined));
      resolved.push(
        resolveImportTarget(`Vendor${i}.Ghost.Deep.Missing`, FROM_FILE, files, undefined),
      );
    }

    // Two passes: the shared workspace/suffix index and the namespace-dir index.
    expect(files.scans).toBe(2);

    // Paired result assertion — a count of 2 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBe('App/Models/User.cs');
    expect(resolved[1]).toBe('App/Services/Service00000.cs');
    expect(resolved[2]).toBeNull();
  });

  it('a distinct file set gets its own indexes (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(20),
      targetRaw: 'App.Models.User',
      fromFile: FROM_FILE,
      resolutionConfig: undefined,
      expected: 'App/Models/User.cs',
      // Two, not one: the shared workspace/suffix index and the namespace-dir
      // index are separate WeakMaps over the same Set.
      expectedScans: 2,
    });
  });

  it('still resolves real usings correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // Whole-path match on the namespace path.
    expect(resolveImportTarget('App.Models.User', FROM_FILE, files, undefined)).toBe(
      'App/Models/User.cs',
    );
    // First `.cs` living directly inside the namespace directory.
    expect(resolveImportTarget('App.Services', FROM_FILE, files, undefined)).toBe(
      'App/Services/Service00000.cs',
    );
    // Progressive prefix stripping: the repo has no `CrossFile/` prefix.
    expect(resolveImportTarget('CrossFile.Domain.Order', FROM_FILE, files, undefined)).toBe(
      'Domain/Order.cs',
    );

    // BCL usings stay gated (#1881) and unknown namespaces resolve to nothing.
    expect(resolveImportTarget('System.Threading.Tasks', FROM_FILE, files, undefined)).toBeNull();
    expect(resolveImportTarget('Vendor.Ghost.Missing', FROM_FILE, files, undefined)).toBeNull();
  });
});

describe('C# import resolution — index reuse on the csproj leg (#2911)', () => {
  it('builds each index once for many usings over a stable file set', () => {
    const files = buildCsprojWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // A namespace-directory hit and a miss, both reaching the array-keyed
      // index — the miss under a fresh namespace each time so no upstream
      // string-level memo can stand in for the index being reused.
      resolved.push(resolveImportTarget('App.Models', FROM_FILE, files, CSPROJ_CONFIG));
      resolved.push(resolveImportTarget(`App.Ghost${i}`, FROM_FILE, files, CSPROJ_CONFIG));
    }

    // One traversal for 400 usings. One, not two: `getCsharpDirIndex` belongs to
    // the no-csproj leg, and the namespace-directory index this branch DOES
    // build reads its file list from the same `getWorkspaceFileIndex` memo
    // rather than re-walking the Set. A defensive copy of the Set at the
    // adapter boundary reads 400 here.
    expect(files.scans).toBe(1);

    // Paired result assertions — the count must not be the count of an adapter
    // that resolves nothing.
    expect(resolved[0]).toBe('src/MyApp/Models/Entity00000.cs');
    expect(resolved[1]).toBeNull();
  });

  it('a distinct file set gets its own indexes (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildCsprojWorkspace(20),
      targetRaw: 'App.Models',
      fromFile: FROM_FILE,
      resolutionConfig: CSPROJ_CONFIG,
      expected: 'src/MyApp/Models/Entity00000.cs',
      // One, not two: see the scan-count comment above.
      expectedScans: 1,
    });
  });
});
