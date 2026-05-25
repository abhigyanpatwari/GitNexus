/**
 * Resolve a Rust `use` import path to a repo-relative file path.
 *
 * Rust module resolution rules:
 *   - `crate::foo::bar` → `src/foo/bar.rs` or `src/foo/bar/mod.rs`
 *   - `super::foo` → parent directory's `foo.rs` or `foo/mod.rs`
 *   - `self::foo` → same directory's `foo.rs` or `foo/mod.rs`
 *   - External crate imports (no `crate::`/`super::`/`self::`) → null
 */
export function resolveRustImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  _resolutionConfig?: unknown,
): string | readonly string[] | null {
  if (!targetRaw) return null;

  const segments = targetRaw.split('::').filter(Boolean);
  if (segments.length === 0) return null;

  const fromNormalized = fromFile.replace(/\\/g, '/');
  const fromDir = fromNormalized.includes('/')
    ? fromNormalized.slice(0, fromNormalized.lastIndexOf('/'))
    : '';

  if (segments[0] === 'crate') {
    const cratePath = segments.slice(1);
    return resolveModulePath(cratePath, findSrcRoot(fromNormalized), allFilePaths);
  }

  if (segments[0] === 'super') {
    const parentDir = fromDir.includes('/') ? fromDir.slice(0, fromDir.lastIndexOf('/')) : '';
    const restPath = segments.slice(1);
    return resolveModulePath(restPath, parentDir, allFilePaths);
  }

  if (segments[0] === 'self') {
    const restPath = segments.slice(1);
    return resolveModulePath(restPath, fromDir, allFilePaths);
  }

  // External crate — try workspace-level resolution
  const workspaceResult = resolveWorkspaceCrate(segments, allFilePaths);
  if (workspaceResult !== null) return workspaceResult;

  // Fallback: treat as implicit crate-relative (Rust 2015 edition or
  // when the first segment matches a sibling module name).
  return resolveModulePath(segments, findSrcRoot(fromNormalized), allFilePaths);
}

function findSrcRoot(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const srcIdx = normalized.lastIndexOf('/src/');
  if (srcIdx !== -1) return normalized.slice(0, srcIdx + 4); // includes trailing /src
  if (normalized.startsWith('src/')) return 'src';
  return '';
}

function resolveModulePath(
  pathSegments: string[],
  baseDir: string,
  allFilePaths: ReadonlySet<string>,
): string | readonly string[] | null {
  if (pathSegments.length === 0) {
    const modPath = baseDir ? `${baseDir}/mod.rs` : 'mod.rs';
    if (allFilePaths.has(modPath)) return modPath;
    return null;
  }

  const modulePath = pathSegments.join('/');

  // Try direct file
  const directFile = baseDir ? `${baseDir}/${modulePath}.rs` : `${modulePath}.rs`;
  if (allFilePaths.has(directFile)) return directFile;

  // Try mod.rs inside directory
  const modFile = baseDir ? `${baseDir}/${modulePath}/mod.rs` : `${modulePath}/mod.rs`;
  if (allFilePaths.has(modFile)) return modFile;

  // Try partial path resolution: for `use crate::models::User` where
  // User is a type inside models.rs, resolve to `src/models.rs`
  if (pathSegments.length >= 2) {
    const parentPath = pathSegments.slice(0, -1).join('/');
    const parentFile = baseDir ? `${baseDir}/${parentPath}.rs` : `${parentPath}.rs`;
    if (allFilePaths.has(parentFile)) return parentFile;

    const parentModFile = baseDir ? `${baseDir}/${parentPath}/mod.rs` : `${parentPath}/mod.rs`;
    if (allFilePaths.has(parentModFile)) return parentModFile;
  }

  // Fallback: try increasingly shorter path prefixes
  for (let i = pathSegments.length - 2; i >= 1; i--) {
    const prefix = pathSegments.slice(0, i).join('/');
    const prefixFile = baseDir ? `${baseDir}/${prefix}.rs` : `${prefix}.rs`;
    if (allFilePaths.has(prefixFile)) return prefixFile;
    const prefixModFile = baseDir ? `${baseDir}/${prefix}/mod.rs` : `${prefix}/mod.rs`;
    if (allFilePaths.has(prefixModFile)) return prefixModFile;
  }

  return null;
}

function resolveWorkspaceCrate(
  segments: string[],
  allFilePaths: ReadonlySet<string>,
): string | null {
  const crateName = segments[0];
  const restSegments = segments.slice(1);

  const candidates = [
    restSegments.length > 0
      ? `${crateName}/src/${restSegments.join('/')}.rs`
      : `${crateName}/src/lib.rs`,
    restSegments.length > 0
      ? `${crateName}/src/${restSegments.join('/')}/mod.rs`
      : `${crateName}/src/lib.rs`,
  ];

  for (const candidate of candidates) {
    if (allFilePaths.has(candidate)) return candidate;
  }

  return null;
}

export interface RustResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}
