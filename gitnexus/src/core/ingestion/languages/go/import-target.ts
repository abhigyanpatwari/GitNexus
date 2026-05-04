import type { GoModuleConfig } from '../../language-config.js';

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

function findRootPackageFiles(allFilePaths: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const raw of allFilePaths) {
    const normalized = raw.replace(/\\/g, '/');
    if (normalized.includes('/')) continue;
    if (!normalized.endsWith('.go') || normalized.endsWith('_test.go')) continue;
    result.push(raw);
  }
  return result.sort();
}

function findAllFilesInPkgDir(allFilePaths: ReadonlySet<string>, pkgPath: string): string[] {
  const pkgDir = '/' + pkgPath + '/';
  const result: string[] = [];
  for (const raw of allFilePaths) {
    const normalized = '/' + raw.replace(/\\/g, '/');
    if (!normalized.includes(pkgDir)) continue;
    if (!normalized.endsWith('.go') || normalized.endsWith('_test.go')) continue;
    // Ensure file is directly in the package directory (not a subdirectory)
    const afterPkg = normalized.substring(normalized.indexOf(pkgDir) + pkgDir.length);
    if (!afterPkg.includes('/')) result.push(raw);
  }
  return result;
}

/** Preserved for backward compat. */
export interface GoResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
  readonly goModule?: GoModuleConfig;
}
