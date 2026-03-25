/**
 * Python import resolution — PEP 328 relative imports and proximity-based bare imports.
 * Import system spec: PEP 302 (original), PEP 451 (current).
 */

import { tryResolveWithExtensions } from './utils.js';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import type { ImportResult, ResolveCtx } from './types.js';
import { resolveStandard } from './standard.js';

/**
 * Resolve a Python import to a file path (low-level helper).
 *
 * 1. Relative (PEP 328): `.module`, `..module` — 1 dot = current package, each extra dot goes up one level.
 * 2. Proximity bare import: static heuristic — checks the importer's own directory first.
 *    Approximates the common case where co-located files find each other without an installed package.
 *    Single-segment only — multi-segment (e.g. `os.path`) falls through to suffixResolve.
 *    Checks package (__init__.py) before module (.py), matching CPython's finder order (PEP 451 §4).
 *    Coexistence of both is physically impossible (same name = file vs directory), so the order
 *    only matters for spec compliance.
 *    Note: implicit namespace packages (Python 3.3+, directory without __init__.py) are not handled.
 *
 * Returns null to let the caller fall through to suffixResolve.
 */
export function resolvePythonImportInternal(
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
): string | null {
  // Relative import — PEP 328 (https://peps.python.org/pep-0328/)
  if (importPath.startsWith('.')) {
    const dotMatch = importPath.match(/^(\.+)(.*)/);
    if (!dotMatch) return null;

    const dotCount = dotMatch[1].length;
    const modulePart = dotMatch[2];
    const dirParts = currentFile.split('/').slice(0, -1);

    // PEP 328: more dots than directory levels → beyond top-level package → invalid
    if (dotCount - 1 > dirParts.length) return null;
    for (let i = 1; i < dotCount; i++) dirParts.pop();

    if (modulePart) {
      dirParts.push(...modulePart.replace(/\./g, '/').split('/'));
    }

    return tryResolveWithExtensions(dirParts.join('/'), allFiles);
  }

  // Proximity bare import — single-segment only; package before module (PEP 451 §4)
  const pathLike = importPath.replace(/\./g, '/');
  if (pathLike.includes('/')) return null;

  // Normalize for Windows backslashes
  const importerDir = currentFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  if (!importerDir) return null;

  if (allFiles.has(`${importerDir}/${pathLike}/__init__.py`)) return `${importerDir}/${pathLike}/__init__.py`;
  if (allFiles.has(`${importerDir}/${pathLike}.py`)) return `${importerDir}/${pathLike}.py`;

  // Ancestor directory walk — Python resolves bare imports against sys.path entries,
  // which typically includes the project root and package directories. Walk up from the
  // importer's directory to find the module in an ancestor, preferring the closest match.
  // This prevents cross-language misresolution (e.g., Python `from middleware import X`
  // resolving to a TypeScript middleware.ts via suffix matching). Issue #417.
  const dirParts = importerDir.split('/');
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const ancestorDir = dirParts.slice(0, i).join('/');
    const prefix = ancestorDir ? `${ancestorDir}/` : '';
    if (allFiles.has(`${prefix}${pathLike}/__init__.py`)) return `${prefix}${pathLike}/__init__.py`;
    if (allFiles.has(`${prefix}${pathLike}.py`)) return `${prefix}${pathLike}.py`;
  }

  return null;
}

/**
 * Python: relative imports (PEP 328) + proximity-based bare imports.
 * Falls through to standard suffix resolution when proximity finds no match.
 */
export function resolvePythonImport(
  rawImportPath: string,
  filePath: string,
  ctx: ResolveCtx,
): ImportResult {
  const resolved = resolvePythonImportInternal(filePath, rawImportPath, ctx.allFilePaths);
  if (resolved) {
    // Store in resolveCache so other files importing the same module skip the
    // ancestor walk. The cache key matches resolveStandard's convention.
    ctx.resolveCache.set(`${filePath}::${rawImportPath}`, resolved);
    return { kind: 'files', files: [resolved] };
  }
  if (rawImportPath.startsWith('.')) return null; // relative but unresolved -- don't suffix-match
  return resolveStandard(rawImportPath, filePath, ctx, SupportedLanguages.Python);
}
