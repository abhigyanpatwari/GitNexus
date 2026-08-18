/**
 * Production-path regression guard for the PHP import-resolution index (#2901).
 *
 * PHP was the last language resolving imports with a full workspace scan per
 * import. Both adapters in `languages/php/import-target.ts` materialized
 * `[...allFilePaths]` twice per import and handed `resolvePhpImportInternal` an
 * `index` of `undefined`, dropping it onto `suffixResolve`'s linear `findIndex`
 * — a pass over every file per path-part × per extension, 98 ms per import at
 * 20k files. They now read the shared `getWorkspaceFileIndex`
 * (`import-resolvers/workspace-file-index.ts`), memoized on the `allFilePaths`
 * Set identity via a WeakMap, through a PHP-specific parity view that keeps the
 * three index-fed fast paths answering exactly what the scans answered (see the
 * `#2901` header in `import-target.ts` — passing the raw shared index straight
 * through MOVES IMPORTS edges, and `test/unit/scope-resolution/
 * php-import-target-parity.test.ts` is the differential that proves this one
 * does not).
 *
 * Resolution reaches that index through `phpScopeResolver.resolveImportTarget`
 * — the orchestrator adapter — not by calling `resolvePhpImportTargetInternal`
 * directly the way the unit parity test does. The adapter must therefore pass
 * the Set THROUGH; a defensive copy (`new Set(allFilePaths)`) would hand a
 * fresh WeakMap key per call and restore the per-import rebuild. Python hit
 * exactly that (PR #1918 review P1), and the parity test cannot see it: it
 * never crosses the adapter.
 *
 * The traversal-count assertions are the perf guard. They are paired with
 * result assertions on purpose: a count of 1 is equally true of an adapter that
 * has stopped resolving anything at all, so counting alone would stay green
 * while every PHP IMPORTS edge disappeared.
 *
 * On the one traversal PHP still pays per import in a specific case — a PSR-4
 * namespace whose directory has no direct `.php` children — see the pinned
 * residual arm at the bottom of the unit parity test. It lives in
 * `import-resolvers/php.ts`, which #2901 does not touch, so the corpora here
 * resolve through the legs that do reach the index.
 */
import { describe, it, expect } from 'vitest';
import { phpScopeResolver } from '../../src/core/ingestion/languages/php/scope-resolver.js';
import type { ComposerConfig } from '../../src/core/ingestion/language-config.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = phpScopeResolver;

const FROM_FILE = 'app/Main.php';

/** The `composer.json` PSR-4 map `loadPhpComposerConfig` would have produced. */
const COMPOSER: ComposerConfig = { psr4: new Map([['App', 'app']]) };

/**
 * A synthetic PSR-4 app: many service classes, plus the shapes the three
 * index-fed legs answer — `app/Models/User.php` for the class-style whole-path
 * hit, the populated `app/Models/` directory for the function-import fallback,
 * and `lib/Legacy/Helper.php` for the suffix fallback that runs when no PSR-4
 * prefix matches.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push(`app/Services/Service${String(i).padStart(5, '0')}.php`);
  }
  files.push('app/Models/User.php');
  files.push('app/Models/functions.php');
  files.push('lib/Legacy/Helper.php');
  files.push('index.php');
  files.push(FROM_FILE);
  return new CountingSet(files);
}

describe('PHP import resolution — index reuse across use-statements (#2901)', () => {
  it('builds the workspace index once for many imports over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // A PSR-4 class hit, a function import that falls back to the namespace
      // directory, and a third-party namespace that misses. The miss is the
      // expensive case: it matches no PSR-4 prefix and so walks every suffix ×
      // every extension before returning null.
      resolved.push(resolveImportTarget('App\\Models\\User', FROM_FILE, files, COMPOSER));
      resolved.push(resolveImportTarget('App\\Models\\getUser', FROM_FILE, files, COMPOSER));
      resolved.push(resolveImportTarget(`Psr\\Log\\Missing${i}`, FROM_FILE, files, COMPOSER));
    }

    expect(files.scans).toBe(1);

    // Paired result assertions — a count of 1 must not be the count of an
    // adapter that resolves nothing.
    expect(resolved[0]).toBe('app/Models/User.php');
    expect(resolved[1]).toBe('app/Models/User.php');
    expect(resolved[2]).toBeNull();
  });

  it('builds the workspace index once with no composer.json at all', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    // `loadResolutionConfig` returns null when the repo has no composer.json,
    // which skips the PSR-4 block entirely and leaves `suffixResolve` — the leg
    // that used to cost a `findIndex` pass per extension — as the only path.
    for (let i = 0; i < 200; i++) {
      resolved.push(resolveImportTarget('Legacy\\Helper', FROM_FILE, files, null));
      resolved.push(resolveImportTarget(`Psr\\Log\\Missing${i}`, FROM_FILE, files, null));
    }

    expect(files.scans).toBe(1);
    expect(resolved[0]).toBe('lib/Legacy/Helper.php');
    expect(resolved[1]).toBeNull();
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(20),
      targetRaw: 'App\\Models\\User',
      fromFile: FROM_FILE,
      resolutionConfig: COMPOSER,
      expected: 'app/Models/User.php',
      expectedScans: 1,
    });
  });

  it('still resolves real use-statements correctly (the perf test is not vacuous)', () => {
    const files = buildWorkspace(5);

    // PSR-4 class-style: `App\Models\User` → `app/Models/User.php`.
    expect(resolveImportTarget('App\\Models\\User', FROM_FILE, files, COMPOSER)).toBe(
      'app/Models/User.php',
    );
    expect(resolveImportTarget('App\\Services\\Service00000', FROM_FILE, files, COMPOSER)).toBe(
      'app/Services/Service00000.php',
    );

    // Composer's non-empty PSR-4 map is authoritative: an unmatched namespace
    // belongs outside the repository and cannot fall through to a local suffix.
    expect(resolveImportTarget('Legacy\\Helper', FROM_FILE, files, COMPOSER)).toBeNull();

    // A root-level file is NOT reachable as a proper suffix — the pre-#2901
    // behaviour the parity view preserves, and the single most likely thing a
    // raw `getWorkspaceFileIndex().index` hand-off would have changed.
    expect(resolveImportTarget('index', FROM_FILE, files, COMPOSER)).toBeNull();

    // Third-party namespaces have no file in the repo.
    expect(resolveImportTarget('Psr\\Log\\LoggerInterface', FROM_FILE, files, COMPOSER)).toBeNull();
  });
});
