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
 * Strategy:
 *   1. With go.mod: resolve only imports owned by that module
 *   2. Without go.mod / GOPATH: progressively shorter directory suffixes
 */
export function resolveGoImportTarget(
  targetRaw: string,
  _fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | readonly string[] | null {
  if (!targetRaw) return null;

  const goModule = resolutionConfig as GoModuleConfig | undefined;

  // 1) go.mod is authoritative: only this module's exact path or subpackages
  //    can name files in the workspace. Standard-library and third-party
  //    imports must not fall through to the suffix matcher below.
  if (goModule != null) {
    const ownedByModule =
      targetRaw === goModule.modulePath || targetRaw.startsWith(`${goModule.modulePath}/`);
    if (!ownedByModule) return null;

    const relativePkg =
      targetRaw === goModule.modulePath ? '' : targetRaw.slice(goModule.modulePath.length + 1); // e.g. "internal/models"
    const files =
      relativePkg === ''
        ? findRootPackageFiles(allFilePaths)
        : findAllFilesInPkgDir(allFilePaths, relativePkg);
    if (files.length > 0) return files;
    return null;
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
 * walks once per path segment — so without go.mod a single unresolved stdlib or
 * third-party import ran the whole cascade before returning null and cost
 * several full workspace scans, making resolution O(imports × files).
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
