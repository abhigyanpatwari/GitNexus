/**
 * Go package import resolution — internal helpers.
 *
 * Strategy lives in configs/go.ts.
 * This file contains the shared helpers used by the strategy.
 *
 * **Reachability, as of #2929:** nothing in production calls either export
 * today. The only path in is `configs/go.ts` → `createImportResolver` →
 * the `importResolver` field on Go's `LanguageProvider`, and that field is
 * read at exactly two lines — `import-target-adapter.ts:74-75` — whose two
 * exports (`buildImportTargetWorkspace`,
 * `resolveImportTargetAcrossLanguages`) have no importer anywhere but their
 * own unit test. So this is a live-looking but currently unwired leg; the
 * tests in `test/unit/import-resolvers/go-package-resolve.test.ts` are the
 * only thing watching it.
 */

import type { GoModuleConfig } from '../language-config.js';

/** `'/'`, for the parent-directory boundary check in `resolveGoPackage`. */
const SLASH_CODE = 47;

/**
 * Extract the package directory suffix from a Go import path.
 * Returns the suffix string (e.g., "/internal/auth/") or null if invalid.
 */
export function resolveGoPackageDir(importPath: string, goModule: GoModuleConfig): string | null {
  if (!importPath.startsWith(goModule.modulePath)) return null;
  const relativePkg = importPath.slice(goModule.modulePath.length + 1);
  if (!relativePkg) return null;
  return '/' + relativePkg + '/';
}

/**
 * Resolve a Go internal package import to all .go files in the package directory.
 * Returns an array of file paths.
 */
export function resolveGoPackage(
  importPath: string,
  goModule: GoModuleConfig,
  normalizedFileList: readonly string[],
  allFileList: readonly string[],
): string[] {
  // Identical to the six lines this used to re-derive; `resolveGoPackageDir`
  // returns the '/'-wrapped form and the scan wants the bare path, so unwrap.
  const pkgDir = resolveGoPackageDir(importPath, goModule);
  if (pkgDir === null) return [];
  const relativePkg = pkgDir.slice(1, -1); // "/internal/auth/" → "internal/auth"

  const pkgLen = relativePkg.length; // >= 1: `resolveGoPackageDir` rejects empty
  const matches: string[] = [];

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    if (!normalized.endsWith('.go') || normalized.endsWith('_test.go')) continue;
    // The file's PARENT directory ends with the package path — the same
    // predicate `package-dir-index.ts` states. This used to ask `indexOf` for
    // the FIRST `/<pkg>/` and then check that nothing after it held a slash,
    // which made `a/pkg/b/pkg/x.go` not a member of `pkg` (#2881).
    //
    // Expressed as "`relativePkg` sits immediately before the last slash, on a
    // segment boundary". The boundary is either the start of the path (an
    // import matching from index 0, `internal/auth/x.go`) or a `/` — which is
    // what the old `'/' + path` cons bought, at the price of a per-file
    // concatenation the first `endsWith` forced V8 to flatten (#2929).
    //
    // Rewriting this as `endsWith(relativePkg, lastSlash)` buys nothing: the
    // two-argument overload measured a wash against `startsWith(needle, pos)`
    // here (10.28 ns vs 9.82 ns), so it trades the clarity of an explicit start
    // index for no gain. A "the 2-arg overload leaves V8's fast path, 20x"
    // claim from review did not reproduce on Node 22.18 — its baseline was a
    // one-argument call that early-exited on the length precheck.
    const start = normalized.lastIndexOf('/') - pkgLen; // < 0 when there is no parent dir
    if (start < 0 || !normalized.startsWith(relativePkg, start)) continue;
    if (start > 0 && normalized.charCodeAt(start - 1) !== SLASH_CODE) continue;
    matches.push(allFileList[i]);
  }

  return matches;
}
