import type { GoModuleConfig } from '../../language-config.js';
import {
  buildPackageDirIndex,
  filesDirectlyInPkgDir,
  sortedRootFiles,
  type PackageDirIndex,
} from '../../import-resolvers/package-dir-index.js';
import { perFileSet } from '../../import-resolvers/per-file-set.js';

/**
 * Resolve a Go import path to ALL .go files in the matching package directory.
 *
 * Go packages are directory-scoped: one import statement brings in every
 * (non-test) .go file in the package directory. Return all matching files so
 * the shared finalize pass creates one ImportEdge per file — enabling both
 * IMPORTS edge fanout AND binding materialization for every exported symbol in
 * the package.
 *
 * Strategy (first match wins):
 *   1. go.mod-based: strip module prefix, match package directory
 *   2. Non-go.mod / GOPATH: progressively shorter directory suffixes
 */
export function resolveGoImportTarget(
  targetRaw: string,
  _fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | readonly string[] | null {
  if (!targetRaw) return null;

  const goModule = resolutionConfig as GoModuleConfig | undefined;

  // 1) go.mod-based: strip module prefix, match directory
  if (
    goModule != null &&
    (targetRaw === goModule.modulePath || targetRaw.startsWith(`${goModule.modulePath}/`))
  ) {
    const relativePkg =
      targetRaw === goModule.modulePath ? '' : targetRaw.slice(goModule.modulePath.length + 1); // e.g. "internal/models"
    const files =
      relativePkg === ''
        ? findRootPackageFiles(allFilePaths)
        : findAllFilesInPkgDir(allFilePaths, relativePkg);
    if (files.length > 0) return files;
  }

  // 2) Non-go.mod / GOPATH: progressively shorter directory suffixes.
  //    "github.com/xxx/yyy/pkg" → try "github.com/xxx/yyy/pkg/" → "xxx/yyy/pkg/" → "yyy/pkg/"
  // Stop at ≥2 segments to avoid matching a single-segment suffix (e.g.
  // "pkg", "util", "internal") to a local directory with the same name.
  const parts = targetRaw.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const files = findAllFilesInPkgDir(allFilePaths, parts.slice(i).join('/'));
    if (files.length > 0) return files;
  }

  return null;
}

/** Go packages exclude `_test.go` files: they are a separate package. */
function isGoPackageFile(normalized: string): boolean {
  return normalized.endsWith('.go') && !normalized.endsWith('_test.go');
}

/**
 * Package index over the file set, memoized on the Set's identity (#2877).
 *
 * Every leg above used to walk all of `allFilePaths`, and the GOPATH fallback
 * walks once per path segment — so a single unresolved import (which is most of
 * them: stdlib and third-party module paths run the whole cascade to completion
 * before returning null) cost several full workspace scans, making resolution
 * O(imports × files).
 *
 * The orchestrator hands the same Set to every import in a pass, so the index
 * is built once per run. `resolveGoImportTarget` must therefore never copy the
 * Set before this point — see `import-resolvers/workspace-file-index.ts`.
 */
const getGoPackageIndex = perFileSet(
  (allFilePaths: ReadonlySet<string>): PackageDirIndex =>
    buildPackageDirIndex(allFilePaths, isGoPackageFile),
);

function findRootPackageFiles(allFilePaths: ReadonlySet<string>): string[] {
  return sortedRootFiles(getGoPackageIndex(allFilePaths));
}

function findAllFilesInPkgDir(allFilePaths: ReadonlySet<string>, pkgPath: string): string[] {
  // Deliberately UNSORTED, unlike the root leg: the previous single-pass scan
  // emitted in Set-iteration order and `filesDirectlyInPkgDir` reproduces it.
  return filesDirectlyInPkgDir(getGoPackageIndex(allFilePaths), pkgPath);
}
