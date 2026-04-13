/**
 * Perl use/require import resolution.
 * Handles module name to file path resolution for Perl's use and require statements.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';
import type { ImportResult, ResolveCtx } from './types.js';

/**
 * Convert Perl module name to file paths.
 *
 * Perl module names like Foo::Bar are resolved to:
 * - Foo/Bar.pm (standard module)
 * - Foo/Bar/index.pm (alternative)
 *
 * @param moduleName - Perl module name (e.g., "Foo::Bar")
 * @returns Array of possible file paths
 */
function moduleNameToPath(moduleName: string): string[] {
  // Convert :: to / for file path
  const basePath = moduleName.replace(/::/g, '/');

  return [
    `${basePath}.pm`, // Standard: Foo::Bar -> Foo/Bar.pm
    `${basePath}/index.pm`, // Alternative: Foo::Bar -> Foo/Bar/index.pm
    `${basePath}.pl`, // Script version: Foo::Bar -> Foo/Bar.pl
  ];
}

/**
 * Resolve a Perl use/require path to a matching .pm/.pl file (low-level helper).
 *
 * @param importPath - Module name or relative path
 * @param normalizedFileList - Normalized file paths for suffix matching
 * @param allFileList - All file paths
 * @param index - Optional suffix index for performance
 * @returns Resolved file path or null
 */
export function resolvePerlImportInternal(
  importPath: string,
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  // Handle relative require: require "./path/to/file"
  if (importPath.startsWith('./') || importPath.startsWith('../')) {
    const pathParts = importPath.split('/').filter(Boolean);
    return suffixResolve(pathParts, normalizedFileList, allFileList, index);
  }

  // Handle absolute file path: require "/absolute/path"
  if (importPath.startsWith('/')) {
    // Try exact match first
    if (allFileList.includes(importPath)) {
      return importPath;
    }

    // Try with .pm extension
    const pmPath = importPath.endsWith('.pm') ? importPath : `${importPath}.pm`;
    if (allFileList.includes(pmPath)) {
      return pmPath;
    }

    return null;
  }

  // Handle module names: Foo::Bar, Foo::Bar::Baz
  if (importPath.includes('::')) {
    const possiblePaths = moduleNameToPath(importPath);

    for (const possiblePath of possiblePaths) {
      const pathParts = possiblePath.split('/').filter(Boolean);
      const resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  // Handle simple module names or bare file names
  // Try as-is first
  const pathParts = importPath.split('/').filter(Boolean);
  let resolved = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  if (resolved) {
    return resolved;
  }

  // Try with .pm extension
  const pmPathParts = [...pathParts.slice(0, -1), `${pathParts[pathParts.length - 1]}.pm`];
  resolved = suffixResolve(pmPathParts, normalizedFileList, allFileList, index);
  if (resolved) {
    return resolved;
  }

  return null;
}

/**
 * Perl: use / require statement resolution.
 *
 * @param rawImportPath - The module name or path from use/require statement
 * @param _filePath - Current file path (unused for Perl)
 * @param ctx - Resolution context with file lists and index
 * @returns ImportResult with resolved files or null
 */
export function resolvePerlImport(
  rawImportPath: string,
  _filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolvePerlImportInternal(
    rawImportPath,
    ctx.normalizedFileList,
    ctx.allFileList,
    ctx.index,
  );

  return resolved ? { kind: 'files', files: [resolved] } : null;
}
