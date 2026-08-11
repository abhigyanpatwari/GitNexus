/**
 * Go package import resolution — internal helpers.
 *
 * Strategy lives in configs/go.ts.
 * This file contains the shared helpers used by the strategy.
 */

import type { GoModuleConfig } from '../language-config.js';

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
  if (!importPath.startsWith(goModule.modulePath)) return [];

  // Strip module path to get relative package path
  const relativePkg = importPath.slice(goModule.modulePath.length + 1); // e.g., "internal/auth"
  if (!relativePkg) return [];

  const pkgSuffix = '/' + relativePkg + '/';
  const matches: string[] = [];

  for (let i = 0; i < normalizedFileList.length; i++) {
    // Prepend '/' so paths like "internal/auth/service.go" match suffix "/internal/auth/"
    const normalized = '/' + normalizedFileList[i];
    if (!normalized.endsWith('.go') || normalized.endsWith('_test.go')) continue;
    // The file's PARENT directory ends with the package path — the same
    // predicate `package-dir-index.ts` states, in the same `endsWith` form.
    // This used to ask `indexOf` for the FIRST `/<pkg>/` and then check that
    // nothing after it held a slash, which made `a/pkg/b/pkg/x.go` not a member
    // of `pkg` (#2881). Writing it as ends-with rather than swapping in
    // `lastIndexOf` also drops the second scan the `includes` guard needed.
    const lastSlash = normalized.lastIndexOf('/'); // >= 0: `normalized` starts with '/'
    if (!normalized.slice(0, lastSlash + 1).endsWith(pkgSuffix)) continue;
    matches.push(allFileList[i]);
  }

  return matches;
}
