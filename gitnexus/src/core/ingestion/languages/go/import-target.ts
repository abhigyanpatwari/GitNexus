import {
  buildPackageDirIndex,
  filesDirectlyInPkgDir,
  filesInDir,
  sortedRootFiles,
  type PackageDirIndex,
} from '../../import-resolvers/package-dir-index.js';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { isGoWorkspaceConfig, locateGoImport } from './workspace-config.js';

/**
 * Resolve a Go import path to ALL .go files in the matching package directory.
 *
 * Go packages are directory-scoped: one import statement brings in every
 * (non-test) .go file in the package directory. Return all matching files so
 * the shared finalize pass creates one ImportEdge per file — enabling both
 * IMPORTS edge fanout AND binding materialization for every exported symbol in
 * the package.
 *
 * Strategy (`resolutionConfig` is every go.mod / go.work in the repo, see
 * `workspace-config.ts`):
 *   1. An in-repo module owns the path: exactly one selected module must
 *      contain the package in the directory under its root. Never a suffix
 *      match — `…/internal/repository` names one module's directory, not every
 *      directory ending in `internal/repository`.
 *   2. The importer is inside a module and nothing owns the path (standard
 *      library, dependencies): unresolved.
 *   3. The importer is outside every module: progressively shorter directory
 *      suffixes, GOPATH style.
 */
export function resolveGoImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | readonly string[] | null {
  if (!targetRaw) return null;

  if (isGoWorkspaceConfig(resolutionConfig)) {
    const location = locateGoImport(resolutionConfig, targetRaw, fromFile);
    if (location.kind === 'external') return null;
    if (location.kind === 'module') {
      const index = getGoPackageIndex(allFilePaths);
      let result: readonly string[] | null = null;
      for (const dir of location.dirs) {
        const files = filesInPkgDir(index, dir);
        if (files.length === 0) continue;
        if (result !== null) return null;
        result = files;
      }
      return result;
    }
  }

  // GOPATH: progressively shorter directory suffixes.
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

/** The package in exactly `dir`: root files sorted, any other directory in
 *  Set order. */
function filesInPkgDir(index: PackageDirIndex, dir: string): string[] {
  return dir === '' ? sortedRootFiles(index) : filesInDir(index, dir);
}

function findAllFilesInPkgDir(allFilePaths: ReadonlySet<string>, pkgPath: string): string[] {
  // Deliberately UNSORTED, unlike the root leg: the previous single-pass scan
  // emitted in Set-iteration order and `filesDirectlyInPkgDir` reproduces it.
  return filesDirectlyInPkgDir(getGoPackageIndex(allFilePaths), pkgPath);
}
