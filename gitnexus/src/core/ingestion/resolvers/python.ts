/** Python import resolution — PEP 328 relative imports and proximity-based bare imports. */

import { tryResolveWithExtensions } from './utils.js';

/**
 * Resolve a Python import to a file path.
 *
 * 1. Relative (PEP 328): `.module`, `..module` — 1 dot = current package, each extra dot goes up one level.
 * 2. Proximity bare import: checks the importer's own directory first (mirrors sys.path index 0).
 *    Single-segment only — multi-segment falls through to suffixResolve.
 *    Checks .py before __init__.py; CPython does the opposite but coexistence is invalid in practice.
 *
 * Returns null to let the caller fall through to suffixResolve.
 */
export function resolvePythonImport(
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
): string | null {
  // Relative import (PEP 328)
  if (importPath.startsWith('.')) {
    const dotMatch = importPath.match(/^(\.+)(.*)/);
    if (!dotMatch) return null;

    const dotCount = dotMatch[1].length;
    const modulePart = dotMatch[2];
    const dirParts = currentFile.split('/').slice(0, -1);

    for (let i = 1; i < dotCount; i++) dirParts.pop();

    if (modulePart) {
      dirParts.push(...modulePart.replace(/\./g, '/').split('/'));
    }

    return tryResolveWithExtensions(dirParts.join('/'), allFiles);
  }

  // Proximity bare import — single-segment only
  const pathLike = importPath.replace(/\./g, '/');
  if (pathLike.includes('/')) return null;

  // Normalize for Windows backslashes
  const importerDir = currentFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  if (!importerDir) return null;

  if (allFiles.has(`${importerDir}/${pathLike}.py`)) return `${importerDir}/${pathLike}.py`;
  if (allFiles.has(`${importerDir}/${pathLike}/__init__.py`)) return `${importerDir}/${pathLike}/__init__.py`;

  return null;
}
