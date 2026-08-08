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
 */
import { describe, it, expect } from 'vitest';
import { csharpScopeResolver } from '../../src/core/ingestion/languages/csharp/scope-resolver.js';
import { CountingSet } from '../helpers/counting-file-set.js';

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
    const a = buildWorkspace(20);
    const b = buildWorkspace(20);

    for (let i = 0; i < 20; i++) {
      expect(resolveImportTarget('App.Models.User', FROM_FILE, a, undefined)).toBe(
        'App/Models/User.cs',
      );
      expect(resolveImportTarget('App.Models.User', FROM_FILE, b, undefined)).toBe(
        'App/Models/User.cs',
      );
    }

    expect(a.scans).toBe(2);
    expect(b.scans).toBe(2);
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
